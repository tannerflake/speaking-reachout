import { revalidatePath } from "next/cache";
import type { createAdminClient } from "@/lib/supabase/admin";
import { getScannedReplyIds } from "@/lib/data";
import { GmailReadScopeMissingError, ingestMessages } from "@/lib/gmail/ingest";
import { GmailNotConnectedError } from "@/lib/gmail/send";
import { classifyReply, type ReplyClassification } from "@/lib/claude/replyClassify";
import { isAutomatedMessage } from "@/lib/outreach/guard";
import { stopFollowupsForOrganization } from "@/lib/followups/stop";
import { orgDomainOfEmail, statusLabel } from "@/lib/utils";
import type { IngestedMessage, LeadStatus } from "@/lib/types";

type Admin = ReturnType<typeof createAdminClient>;

export interface ScanSummary {
  scanned?: number; // new inbound messages examined this run
  replies?: number; // genuine human replies matched to sent outreach
  autoReplies?: number; // out-of-office etc.; these do NOT stop follow-ups
  bounces?: number; // delivery failures matched to sent outreach
  leadsUpdated?: number; // leads whose status changed
  nothingNew?: boolean;
  error?: string;
}

// Statuses we never auto-change: a booked/closed lead is beyond the reach of an
// inbox reply, and we must never downgrade one.
const PROTECTED: LeadStatus[] = ["booked", "closed", "closed_not_me"];

interface TrackedLead {
  id: string;
  name: string;
  status: LeadStatus;
  /** When we first emailed anyone at this lead; older mail can't be a reply. */
  firstSentAt: string;
}

interface TrackedThread {
  outreachId: string;
  lead: TrackedLead;
  contactEmail: string | null;
}

/** How an inbound message was tied to a lead. */
type Match =
  | { kind: "thread" | "contact"; outreachId: string; leads: TrackedLead[] }
  | { kind: "domain"; outreachId: null; leads: TrackedLead[] };

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

function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

const one = <T,>(v: T | T[] | null): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : v;

/**
 * Scan the connected mailbox for responses to sent outreach.
 *
 * Rule: follow-ups are only for organizations that have NOT responded. A
 * human reply from anyone at the organization (in the original thread, in a
 * new thread from a contact we emailed, or from a colleague at the same
 * domain) marks the lead Interested / Not interested and stops follow-ups to
 * every contact there. Out-of-office auto-replies are logged but change
 * nothing: that person hasn't actually responded.
 *
 * Runs before every follow-up batch (scheduler and operator buttons) and from
 * the "Scan email" button. Never throws; errors come back in `error`.
 */
export async function scanInboxForReplies(admin: Admin): Promise<ScanSummary> {
  try {
    // 1. Everything we've sent: Gmail thread -> outreach, contact email ->
    //    outreach, and org domain -> leads.
    const { data: outreachRows, error: outreachErr } = await admin
      .from("outreach")
      .select(
        "id, lead_id, sent_at, gmail_thread_id, contact:contacts(email), lead:leads(id, name, status)",
      )
      .eq("status", "sent")
      .eq("sequence_step", 0) // follow-ups share the thread; track by the original
      .order("sent_at", { ascending: true });
    if (outreachErr) return { error: outreachErr.message };

    type OutreachRow = {
      id: string;
      lead_id: string;
      sent_at: string | null;
      gmail_thread_id: string | null;
      contact: { email: string | null } | { email: string | null }[] | null;
      lead:
        | { id: string; name: string; status: LeadStatus }
        | { id: string; name: string; status: LeadStatus }[]
        | null;
    };

    const leads = new Map<string, TrackedLead>();
    const threads = new Map<string, TrackedThread>();
    const byContact = new Map<string, TrackedThread>();
    const byDomain = new Map<string, Set<string>>(); // domain -> lead ids
    for (const row of (outreachRows ?? []) as unknown as OutreachRow[]) {
      const l = one(row.lead);
      if (!l) continue;
      let lead = leads.get(l.id);
      if (!lead) {
        lead = {
          id: l.id,
          name: l.name,
          status: l.status,
          firstSentAt: row.sent_at ?? new Date(0).toISOString(),
        };
        leads.set(l.id, lead);
      }
      const email = one(row.contact)?.email?.trim().toLowerCase() ?? null;
      const tracked: TrackedThread = { outreachId: row.id, lead, contactEmail: email };
      if (row.gmail_thread_id) threads.set(row.gmail_thread_id, tracked);
      if (email && !byContact.has(email)) byContact.set(email, tracked);
      const domain = orgDomainOfEmail(email);
      if (domain) {
        if (!byDomain.has(domain)) byDomain.set(domain, new Set());
        byDomain.get(domain)!.add(l.id);
      }
    }

    // Nothing sent yet → nothing to scan against.
    if (leads.size === 0) return { nothingNew: true, scanned: 0 };

    function match(m: IngestedMessage): Match | null {
      const t = threads.get(m.threadId);
      if (t) return { kind: "thread", outreachId: t.outreachId, leads: [t.lead] };
      const sender = senderAddress(m.from);
      const c = byContact.get(sender);
      if (c && m.internalDate >= c.lead.firstSentAt) {
        return { kind: "contact", outreachId: c.outreachId, leads: [c.lead] };
      }
      const domain = orgDomainOfEmail(sender);
      const ids = domain ? byDomain.get(domain) : undefined;
      if (ids) {
        const matched = [...ids]
          .map((id) => leads.get(id)!)
          .filter((l) => m.internalDate >= l.firstSentAt);
        if (matched.length) return { kind: "domain", outreachId: null, leads: matched };
      }
      return null;
    }

    // 2. Fetch only NEW inbox mail (dedup against our own scanner's set).
    const scannedIds = await getScannedReplyIds();
    const ingest = await ingestMessages({
      processedIds: scannedIds,
      inboxOnly: true,
    });
    const inbound = ingest.messages
      .filter((m) => !m.isSent)
      .sort((a, b) => a.internalDate.localeCompare(b.internalDate));

    let replies = 0;
    let autoReplies = 0;
    let bounces = 0;
    const updatedLeads = new Set<string>();
    const note = (leadId: string, detail: string) =>
      admin.from("interactions").insert({ lead_id: leadId, kind: "note", detail });

    // 3. Process each new inbound message that belongs to a lead we emailed.
    for (const m of inbound) {
      const hit = match(m);
      if (!hit) continue;

      if (isBounce(m)) {
        // Only a bounce in our own thread tells us which address failed.
        if (hit.kind !== "thread") continue;
        bounces += 1;
        await admin
          .from("outreach")
          .update({ bounced_at: new Date().toISOString() })
          .eq("id", hit.outreachId)
          .is("bounced_at", null);
        await admin
          .from("followup_sequences")
          .update({ status: "stopped", stop_reason: "Email bounced.", next_due_at: null })
          .eq("outreach_id", hit.outreachId)
          .in("status", ["active", "paused"]);
        await note(
          hit.leads[0].id,
          `Delivery failed: an email to ${threads.get(m.threadId)?.contactEmail ?? "the contact"} bounced. Consider re-looking up the address.`,
        );
        continue;
      }

      const fromName = m.from.replace(/\s*<[^>]*>\s*/, "").trim() || m.from;

      // Out-of-office and similar: obvious from headers, no model call needed.
      let classification: ReplyClassification;
      let summary: string;
      if (isAutomatedMessage(m.from, m.subject)) {
        classification = "auto_reply";
        summary = m.subject || "Automatic reply.";
      } else {
        ({ classification, note: summary } = await classifyReply({
          leadName: hit.leads.map((l) => l.name).join(" / "),
          from: m.from,
          subject: m.subject,
          body: m.body,
          inOriginalThread: hit.kind === "thread",
        }));
      }

      if (classification === "unrelated") continue;

      if (classification === "auto_reply") {
        // Not a response. Follow-ups continue as scheduled.
        autoReplies += 1;
        for (const l of hit.leads) {
          await note(l.id, `Auto-reply from ${fromName}: ${summary} (follow-ups continue).`);
        }
        continue;
      }

      // A person at the organization responded.
      replies += 1;
      if (hit.outreachId) {
        await admin
          .from("outreach")
          .update({ replied_at: new Date().toISOString() })
          .eq("id", hit.outreachId)
          .is("replied_at", null);
      }

      const ambiguous = hit.leads.length > 1;
      for (const l of hit.leads) {
        await stopFollowupsForOrganization(
          admin,
          l.id,
          `${fromName} replied; follow-ups to everyone at this organization stopped.`,
        );
        await note(
          l.id,
          `Reply from ${fromName}: ${summary} Follow-ups to everyone at this organization stopped.${
            ambiguous
              ? ` (Came from @${orgDomainOfEmail(senderAddress(m.from))}, which matches several leads; set the status by hand.)`
              : ""
          }`,
        );
        if (ambiguous) continue;

        const target: LeadStatus =
          classification === "interested"
            ? "interested"
            : classification === "cant_pay"
              ? "cant_pay"
              : "not_interested";
        // One interested person keeps the lead Interested even if a colleague
        // later declines; the decline is still in the activity log.
        const keepInterested = l.status === "interested" && target !== "interested";
        if (target !== l.status && !PROTECTED.includes(l.status) && !keepInterested) {
          await admin.from("leads").update({ status: target }).eq("id", l.id);
          await admin.from("interactions").insert({
            lead_id: l.id,
            kind: "status_change",
            detail: `Status set to ${statusLabel(target)} (auto: reply from ${fromName}).`,
          });
          l.status = target; // later messages in this run see the new status
          updatedLeads.add(l.id);
        }
        revalidatePath(`/admin/leads/${l.id}`);
      }
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

    if (replies === 0 && bounces === 0 && autoReplies === 0) {
      return { nothingNew: true, scanned: inbound.length };
    }
    return {
      scanned: inbound.length,
      replies,
      autoReplies,
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
