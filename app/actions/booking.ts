"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendGmail } from "@/lib/gmail/send";
import { getEnv } from "@/lib/env";
import { stripEmDashes } from "@/lib/site/sanitize";

export interface BookingInput {
  name: string;
  email: string;
  organization: string;
  event_type: string;
  timeframe: string;
  message: string;
  // Honeypot: real users never see or fill this. Bots often do.
  company_url?: string;
}

export interface BookingResult {
  ok: boolean;
  error?: string;
}

const EVENT_TYPES = [
  "University Event",
  "Keynote",
  "Corporate Retreat",
  "Panel",
  "Q&A",
  "Commencement",
  "Other",
];

// Lightweight in-memory rate limit. Per server instance, resets on deploy.
// Enough to blunt naive form spam without a dedicated store.
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
 * Public booking form submission. Captures the inquiry into `inbound_leads`,
 * mirrors it into the CRM `leads` pipeline tagged source='website_inbound' so
 * Cheryl/Tanner triage it alongside outbound prospects, and emails a
 * notification. Write-only from the public side: no CRM data is ever returned.
 */
export async function submitBooking(input: BookingInput): Promise<BookingResult> {
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

  const name = input.name.trim();
  const email = input.email.trim();
  const organization = input.organization.trim();
  const eventType = EVENT_TYPES.includes(input.event_type)
    ? input.event_type
    : "Other";
  const timeframe = stripEmDashes(input.timeframe.trim());
  const message = stripEmDashes(input.message.trim());

  if (!name || !organization) {
    return { ok: false, error: "Name and organization are required." };
  }
  if (!isEmail(email)) {
    return { ok: false, error: "Please enter a valid email address." };
  }

  const admin = createAdminClient();

  // 1) Mirror into the CRM leads pipeline so it surfaces alongside outbound.
  //    The lead is the organization; the person becomes a contact.
  let crmLeadId: string | null = null;
  const { data: leadRow } = await admin
    .from("leads")
    .insert({
      name: organization,
      type: "other",
      description: `Inbound website inquiry from ${name} (${email}).`,
      status: "new",
      source: "website_inbound",
      fit_rationale: message || null,
    })
    .select("id")
    .single();

  if (leadRow) {
    crmLeadId = (leadRow as { id: string }).id;
    await admin.from("contacts").insert({
      lead_id: crmLeadId,
      name,
      email,
      contact_status: "unverified",
    });
    const detail = [
      `Website booking inquiry. Event type: ${eventType}.`,
      timeframe ? `Timeframe: ${timeframe}.` : null,
      message ? `Message: ${message}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    await admin
      .from("interactions")
      .insert({ lead_id: crmLeadId, kind: "note", detail });
  }

  // 2) Persist the full inquiry to inbound_leads (the canonical capture).
  const { error: inboundError } = await admin.from("inbound_leads").insert({
    name,
    email,
    organization,
    event_type: eventType,
    timeframe: timeframe || null,
    message: message || null,
    source: "website_inbound",
    status: "new",
    crm_lead_id: crmLeadId,
  });
  if (inboundError) {
    return { ok: false, error: "Something went wrong. Please email us instead." };
  }

  // 3) Notify the team. Never auto-reply to the prospect. A failure here must
  //    not lose the captured lead, so it is best-effort.
  const notify = getEnv("BOOKING_NOTIFY_EMAIL") ?? "cheryl@jeffflake.com";
  try {
    await sendGmail({
      to: notify,
      subject: `New speaking inquiry: ${organization}`,
      body: [
        "A new booking inquiry came in through jeffflake.com:",
        "",
        `Name: ${name}`,
        `Email: ${email}`,
        `Organization: ${organization}`,
        `Event type: ${eventType}`,
        timeframe ? `Timeframe: ${timeframe}` : null,
        "",
        message ? `Message:\n${message}` : "(No message provided.)",
        "",
        crmLeadId ? "This lead has been added to the CRM pipeline." : "",
      ]
        .filter((l) => l !== null)
        .join("\n"),
    });
  } catch {
    // Gmail not connected or send failed; the lead is still safely captured.
  }

  return { ok: true };
}
