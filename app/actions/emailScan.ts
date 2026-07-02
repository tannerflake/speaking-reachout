"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getScannedReplyIds } from "@/lib/data";
import { GmailReadScopeMissingError, ingestMessages } from "@/lib/gmail/ingest";
import { GmailNotConnectedError } from "@/lib/gmail/send";
import { classifyReply } from "@/lib/claude/replyClassify";
import { statusLabel } from "@/lib/utils";
import type { IngestedMessage, LeadStatus } from "@/lib/types";

export interface ScanSummary {
  scanned?: number; // new inbound messages examined this run
  replies?: number; // genuine human replies matched to sent outreach
  bounces?: number; // delivery failures matched to sent outreach
  leadsUpdated?: number; // leads whose status changed
  nothingNew?: boolean;
  error?: string;
}

// Statuses we never auto-change: a booked/closed lead is beyond the reach of an
// inbox reply, and we must never downgrade one.
const PROTECTED: LeadStatus[] = ["booked", "closed", "closed_not_me"];

interface TrackedThread {
  outreachId: string;
  leadId: string;
  leadName: string;
  leadStatus: LeadStatus;
  contactEmail: string | null;
}

function isBounce(m: IngestedMessage): boolean {
  const from = m.from.toLowerCase();
  const subj = m.subject.toLowerCase();
  return (
    from.includes("mailer-daemon") ||
    from.includes("postmaster") ||
    subj.includes("delivery status notification") ||
    subj.includes("undeliverable") ||
    subj.includes("undelivered mail") ||
    subj.includes("delivery has failed") ||
    subj.includes("returned mail") ||
    subj.includes("failure notice")
  );
}

/**
 * Scan the connected mailbox for responses to sent outreach and update lead
 * status/notes. Operator-triggered (button press) — never automatic. Cheap by
 * design: message matching is fully deterministic; the LLM only classifies the
 * handful of genuine replies found.
 */
export async function scanForReplies(): Promise<ScanSummary> {
  try {
    const admin = createAdminClient();

    // 1. Build a map of Gmail thread -> the sent outreach that started it.
    const { data: outreachRows, error: outreachErr } = await admin
      .from("outreach")
      .select(
        "id, lead_id, gmail_thread_id, contact:contacts(email), lead:leads(id, name, status)",
      )
      .eq("status", "sent")
      .not("gmail_thread_id", "is", null);
    if (outreachErr) return { error: outreachErr.message };

    // Supabase types embedded relations as arrays; a to-one FK still returns a
    // single object at runtime, so normalize both possibilities.
    type OutreachRow = {
      id: string;
      lead_id: string;
      gmail_thread_id: string | null;
      contact: { email: string | null } | { email: string | null }[] | null;
      lead:
        | { id: string; name: string; status: LeadStatus }
        | { id: string; name: string; status: LeadStatus }[]
        | null;
    };
    const one = <T,>(v: T | T[] | null): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : v;

    const threads = new Map<string, TrackedThread>();
    for (const row of (outreachRows ?? []) as unknown as OutreachRow[]) {
      const lead = one(row.lead);
      const contact = one(row.contact);
      if (!row.gmail_thread_id || !lead) continue;
      threads.set(row.gmail_thread_id, {
        outreachId: row.id,
        leadId: row.lead_id,
        leadName: lead.name,
        leadStatus: lead.status,
        contactEmail: contact?.email ?? null,
      });
    }

    // Nothing sent yet → nothing to scan against.
    if (threads.size === 0) return { nothingNew: true, scanned: 0 };

    // 2. Fetch only NEW inbox mail (dedup against our own scanner's set).
    const scannedIds = await getScannedReplyIds();
    const ingest = await ingestMessages({
      processedIds: scannedIds,
      inboxOnly: true,
    });
    const inbound = ingest.messages.filter((m) => !m.isSent);

    let replies = 0;
    let bounces = 0;
    const updatedLeads = new Set<string>();

    // 3. Process each new inbound message that belongs to a tracked thread.
    for (const m of inbound) {
      const t = threads.get(m.threadId);
      if (!t) continue;

      if (isBounce(m)) {
        bounces += 1;
        await admin
          .from("outreach")
          .update({ bounced_at: new Date().toISOString() })
          .eq("id", t.outreachId)
          .is("bounced_at", null);
        await admin.from("interactions").insert({
          lead_id: t.leadId,
          kind: "note",
          detail: `Delivery failed — email to ${t.contactEmail ?? "the contact"} bounced. Consider re-looking up the address.`,
        });
        continue;
      }

      // Genuine reply → classify intent (the only LLM call in the scan).
      const { classification, note } = await classifyReply({
        leadName: t.leadName,
        from: m.from,
        subject: m.subject,
        body: m.body,
      });
      replies += 1;

      await admin
        .from("outreach")
        .update({ replied_at: new Date().toISOString() })
        .eq("id", t.outreachId)
        .is("replied_at", null);

      const fromName = m.from.replace(/\s*<[^>]*>\s*/, "").trim() || m.from;
      await admin.from("interactions").insert({
        lead_id: t.leadId,
        kind: "note",
        detail: `Reply from ${fromName}: ${note}`,
      });

      // Map classification to a status, honoring guardrails.
      const target: LeadStatus | null =
        classification === "interested"
          ? "interested"
          : classification === "not_interested"
            ? "not_interested"
            : null; // auto_reply → no status change

      if (
        target &&
        target !== t.leadStatus &&
        !PROTECTED.includes(t.leadStatus)
      ) {
        await admin.from("leads").update({ status: target }).eq("id", t.leadId);
        await admin.from("interactions").insert({
          lead_id: t.leadId,
          kind: "status_change",
          detail: `Status set to ${statusLabel(target)} (auto: reply detected).`,
        });
        // Keep the local copy in sync in case the same thread appears twice.
        t.leadStatus = target;
        updatedLeads.add(t.leadId);
      }

      revalidatePath(`/admin/leads/${t.leadId}`);
    }

    // 4. Record every inbound message we examined so the next scan only looks
    // at genuinely new mail (matched or not — unmatched inbox is noise too).
    const rows = ingest.messages.map((m) => ({
      gmail_message_id: m.id,
      internal_date: m.internalDate,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await admin
        .from("reply_scan_messages")
        .upsert(rows.slice(i, i + 500), {
          onConflict: "gmail_message_id",
          ignoreDuplicates: true,
        });
    }

    revalidatePath("/admin/leads");
    revalidatePath("/admin/admin");

    if (replies === 0 && bounces === 0) {
      return { nothingNew: true, scanned: inbound.length };
    }
    return {
      scanned: inbound.length,
      replies,
      bounces,
      leadsUpdated: updatedLeads.size,
    };
  } catch (e) {
    if (
      e instanceof GmailNotConnectedError ||
      e instanceof GmailReadScopeMissingError
    ) {
      return { error: e.message };
    }
    return { error: e instanceof Error ? e.message : "Scan failed." };
  }
}
