"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendGmail } from "@/lib/gmail/send";
import { appUrl, getEnv } from "@/lib/env";
import { stripEmDashes } from "@/lib/site/sanitize";
import {
  INQUIRY_NOTE_LABEL,
  INQUIRY_TYPE_LABEL,
  isInquiryType,
} from "@/lib/leads/kind";
import type { InquiryType } from "@/lib/types";

export interface InquiryInput {
  name: string;
  email: string;
  phone?: string;
  inquiry_type: string;
  message: string;
  // Honeypot: real users never see or fill this. Bots often do.
  company_url?: string;
}

export interface InquiryResult {
  ok: boolean;
  error?: string;
}

// Same lightweight in-memory rate limit as the booking form (per server
// instance, resets on deploy), kept separate so one form can't starve the other.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_MAX;
}

function isEmail(v: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
}

/**
 * Public "Press & other inquiries" submission. Creates a CRM lead with
 * kind='inquiry' (never a speaking prospect: no drafting, contact finding,
 * follow-ups or pipeline stats), the person as a contact, a note with the
 * message, and emails the team the same way booking inquiries do. Never
 * auto-replies to the submitter. Write-only from the public side.
 */
export async function submitInquiry(input: InquiryInput): Promise<InquiryResult> {
  // Honeypot tripped -> pretend success, write nothing.
  if (input.company_url && input.company_url.trim() !== "") {
    return { ok: true };
  }

  const hdrs = await headers();
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    hdrs.get("x-real-ip") ||
    "unknown";
  if (rateLimited(ip)) {
    return { ok: false, error: "Too many submissions. Please try again later." };
  }

  const name = stripEmDashes(input.name.trim()).slice(0, 200);
  const email = input.email.trim().slice(0, 320);
  const phone = (input.phone ?? "").trim().slice(0, 50);
  const type: InquiryType = isInquiryType(input.inquiry_type) ? input.inquiry_type : "press";
  const message = stripEmDashes(input.message.trim()).slice(0, 5000);

  if (!name) return { ok: false, error: "Please enter your name." };
  if (!isEmail(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (!message) return { ok: false, error: "Please include a message." };

  const typeLabel = INQUIRY_TYPE_LABEL[type];
  const noteLabel = INQUIRY_NOTE_LABEL[type];
  const admin = createAdminClient();

  // 1) CRM lead, kind='inquiry'. If the database predates migration 0036 the
  //    insert fails and NO lead is created (it must never land as a speaking
  //    prospect); the email below still reaches the team.
  let crmLeadId: string | null = null;
  const { data: leadRow } = await admin
    .from("leads")
    .insert({
      name: `${name} (${typeLabel})`,
      type: "other",
      description: `Website ${noteLabel.toLowerCase()} inquiry from ${name} (${email}).`,
      status: "new",
      source: "website_inbound",
      kind: "inquiry",
      inquiry_type: type,
    })
    .select("id")
    .single();

  if (leadRow) {
    crmLeadId = (leadRow as { id: string }).id;
    const contact: Record<string, string> = {
      lead_id: crmLeadId,
      name,
      email,
      contact_status: "unverified",
    };
    // contacts.phone arrives with migration 0034; keep the contact without it.
    const withPhone = await admin
      .from("contacts")
      .insert(phone ? { ...contact, phone } : contact);
    if (withPhone.error && phone) await admin.from("contacts").insert(contact);

    const detail = [
      `Website ${noteLabel} inquiry.`,
      `Type: ${typeLabel}.`,
      phone ? `Phone: ${phone}.` : null,
      `Message: ${message}`,
    ]
      .filter(Boolean)
      .join(" ");
    await admin
      .from("interactions")
      .insert({ lead_id: crmLeadId, kind: "note", detail });
  }

  // 2) Notify the team exactly like booking inquiries (same Gmail sender and
  //    recipient), with Reply-To set to the submitter so Cheryl can answer
  //    straight from her inbox. Never auto-reply to the submitter.
  const notify = getEnv("BOOKING_NOTIFY_EMAIL") ?? "cheryl@jeffflake.com";
  const subject =
    type === "press"
      ? `New press inquiry from ${name}`
      : `New inquiry (${typeLabel}) from ${name}`;
  let notified = false;
  try {
    await sendGmail({
      to: notify,
      replyTo: email,
      subject,
      body: [
        "A new non-booking inquiry came in through jeffflake.com:",
        "",
        `Type: ${typeLabel}`,
        `Name: ${name}`,
        `Email: ${email}`,
        `Phone: ${phone || "(not provided)"}`,
        "",
        `Message:\n${message}`,
        "",
        crmLeadId
          ? `In the CRM: ${appUrl()}/admin/leads/${crmLeadId}`
          : "(Not saved to the CRM; reply from this email.)",
        "",
        "This is not a speaking booking. Reply manually; nothing is sent automatically.",
      ].join("\n"),
    });
    notified = true;
  } catch {
    // Gmail not connected or send failed; the lead is still captured.
  }

  if (!crmLeadId && !notified) {
    return { ok: false, error: "Something went wrong. Please email us instead." };
  }
  return { ok: true };
}
