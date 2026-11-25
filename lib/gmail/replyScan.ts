import { revalidatePath } from "next/cache";
import { inquiryLeadIds } from "@/lib/leads/kind";
import type { createAdminClient } from "@/lib/supabase/admin";
import { getScannedReplyIds } from "@/lib/data";
import { GmailReadScopeMissingError, ingestMessages } from "@/lib/gmail/ingest";
import { GmailNotConnectedError } from "@/lib/gmail/send";
import { classifyReply, type ReplyClassification } from "@/lib/claude/replyClassify";
import { isAutomatedMessage } from "@/lib/outreach/guard";
import { stopFollowupsForOrganization } from "@/lib/followups/stop";
import { classifyBounce } from "@/lib/gmail/bounce";
import { markAddressBounced } from "@/lib/contacts/deliverability";
import { orgDomainOfEmail, statusLabel } from "@/lib/utils";
import { localDatePlus } from "@/lib/attribution";
import {
  detectHolidayOoo,
  holidayResumeDate,
  inHolidayWindow,
  mightBeHolidayOoo,
} from "@/lib/followups/holiday";
import { applyHolidayOoo } from "@/lib/followups/holidayApply";
import type { IngestedMessage, LeadStatus } from "@/lib/types";

type Admin = ReturnType<typeof createAdminClient>;

export interface ScanSummary {
  scanned?: number; // new inbound messages examined this run
  replies?: number; // genuine human replies matched to sent outreach
  autoReplies?: number; // out-of-office etc.; these do NOT stop follow-ups
  holidayOoo?: number; // holiday out-of-office: that contact's nudges delayed
  bounces?: number; // delivery failures matched to sent outreach
  leadsUpdated?: number; // leads whose status changed
  nothingNew?: boolean;
  error?: string;
}

// Statuses we never auto-change: a booked/closed lead is beyond the reach of an
// inbox reply, and we must never downgrade one.
const PROTECTED: LeadStatus[] = ["booked", "closed", "closed_not_me"];

// How engaged a reply-driven status is. A later reply never moves a lead to a
// lower rank (statuses not listed are 0, so any reply can move them).
const ENGAGEMENT_RANK: Partial<Record<LeadStatus, number>> = {
  interested: 2,
  back_burner: 1,
};
const rank = (s: LeadStatus) => ENGAGEMENT_RANK[s] ?? 0;

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

/**
 * Update a lead's revisit fields. revisit_note arrives with migration 0034;
 * until it is applied the update is retried without it.
 */
async function updateRevisitFields(
  admin: Admin,
  leadId: string,
  patch: { status?: LeadStatus; revisit_on: string | null; revisit_note?: string | null },
): Promise<void> {
  const { error } = await admin.from("leads").update(patch).eq("id", leadId);
  if (error && /revisit_note/.test(error.message) && "revisit_note" in patch) {
    const { revisit_note: _omit, ...rest } = patch;
    void _omit;
    await admin.from("leads").update(rest).eq("id", leadId);
  }
}

/**
 * Apply a human reply to the lead's revisit date.
 * - The reply states new timing: move the date there (noting the old date
 *   when the org came back before it).
 * - No timing, and the stored date is still in the future: the org came back
 *   early, so clear the date and note (logging the old values).
 * - No timing, and the date is today or past: leave it (already surfaced).
 * Returns true when the lead changed.
 */
async function applyRevisitForReply(
  admin: Admin,
  leadId: string,
  reply: { fromName: string; revisitOn: string | null; revisitReason: string | null },
): Promise<boolean> {
  // Read fresh (select * so a missing revisit_note column isn't an error).
  const { data } = await admin.from("leads").select("*").eq("id", leadId).maybeSingle();
  const lead = data as { revisit_on?: string | null; revisit_note?: string | null } | null;
  if (!lead) return false;
  const oldOn = lead.revisit_on ?? null;
  const oldNote = lead.revisit_note?.trim() || null;
  const today = localDatePlus(0);
  const early = Boolean(oldOn && oldOn > today);
  const note = (detail: string) =>
    admin.from("interactions").insert({ lead_id: leadId, kind: "note", detail });

  if (reply.revisitOn) {
    const newNote = reply.revisitReason?.trim() || null;
    if (reply.revisitOn === oldOn && (!newNote || newNote === oldNote)) return false;
    // Never blank out an existing note with an empty reason.
    await updateRevisitFields(admin, leadId, {
      revisit_on: reply.revisitOn,
      ...(newNote ? { revisit_note: newNote } : {}),
    });
    if (early) {
      await note(
        `Revisit date changed from ${oldOn} (${oldNote ?? "no note"}) to ${reply.revisitOn} (${newNote ?? oldNote ?? "no note"}): ${reply.fromName} replied early.`,
      );
    } else {
      await note(
        `Revisit date set to ${reply.revisitOn}${newNote ? ` (${newNote})` : ""} (auto: reply from ${reply.fromName}).`,
      );
    }
    return true;
  }

  if (!early) return false;
  await updateRevisitFields(admin, leadId, { revisit_on: null, revisit_note: null });
  await note(
    `Revisit date ${oldOn} cleared (was: ${oldNote ?? "no note"}): ${reply.fromName} replied before the revisit date.`,
  );
  return true;
}

// Mailer daemons and no-reply senders: never worth a model call.
const AUTOMATED_SENDER = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)/i;

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
 * domain) marks the lead Interested / Back burner / Not interested and stops follow-ups to
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

    // Non-booking inquiries (a lead reclassified after outreach went out):
    // replies are still logged, but status and revisit dates never change.
    const inquiries = await inquiryLeadIds(admin, [...leads.keys()]);

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
    let holidayOoo = 0;
    let bounces = 0;
    const updatedLeads = new Set<string>();
    const note = (leadId: string, detail: string) =>
      admin.from("interactions").insert({ lead_id: leadId, kind: "note", detail });

    // 3. Process each new inbound message that belongs to a lead we emailed.
    for (const m of inbound) {
      // Delivery failures first: a bounce is the mail system, never a reply,
      // and must not mark anyone Interested / Not interested or count as
      // "already in contact". It is matched by our thread, or by the failed
      // address when the bounce arrives outside the thread.
      const bounce = classifyBounce({ from: m.from, subject: m.subject, body: m.body });
      if (bounce) {
        const inThread = threads.get(m.threadId);
        const targets: TrackedThread[] = inThread
          ? [inThread]
          : bounce.failedRecipients
              .map((a) => byContact.get(a))
              .filter((t): t is TrackedThread => Boolean(t));
        for (const t of targets) {
          bounces += 1;
          await admin
            .from("outreach")
            .update({ bounced_at: new Date().toISOString() })
            .eq("id", t.outreachId)
            .is("bounced_at", null);
          await admin
            .from("followup_sequences")
            .update({ status: "stopped", stop_reason: "Email bounced.", next_due_at: null })
            .eq("outreach_id", t.outreachId)
            .in("status", ["active", "paused"]);
          if (bounce.hard && t.contactEmail) {
            await markAddressBounced(admin, t.contactEmail, "permanent delivery failure");
          } else {
            await note(
              t.lead.id,
              `Delivery to ${t.contactEmail ?? "the contact"} failed temporarily (mailbox full or server busy); follow-ups to them stopped. The address was not marked bad.`,
            );
          }
        }
        continue;
      }

      const hit = match(m);
      if (!hit) continue;

      const fromName = m.from.replace(/\s*<[^>]*>\s*/, "").trim() || m.from;

      // Out-of-office and similar: obvious from headers, no model call needed.
      let classification: ReplyClassification;
      let summary: string;
      let revisitOn: string | null = null;
      let revisitReason: string | null = null;
      let oooHoliday = false;
      let oooReturnDate: string | null = null;
      const classifyInput = {
        leadName: hit.leads.map((l) => l.name).join(" / "),
        from: m.from,
        subject: m.subject,
        body: m.body,
        inOriginalThread: hit.kind === "thread",
      };
      if (isAutomatedMessage(m.from, m.subject)) {
        classification = "auto_reply";
        summary = m.subject || "Automatic reply.";
      } else {
        ({ classification, note: summary, revisitOn, revisitReason, oooHoliday, oooReturnDate } =
          await classifyReply(classifyInput));
      }

      if (classification === "unrelated") continue;

      if (classification === "auto_reply") {
        // Not a response: lead status never changes on an auto-reply.
        autoReplies += 1;

        // Holiday out-of-office? Regex first; the model only when the regex
        // can't tell and the text hints at holiday timing (header-detected
        // OOOs skip the model above, so ask it here for the dates only).
        const today = localDatePlus(0);
        const text = `${m.subject}\n${m.body}`;
        const det = detectHolidayOoo(text, today);
        if (!det.returnDate && oooReturnDate) det.returnDate = oooReturnDate;
        if (
          !det.returnDate &&
          !oooHoliday &&
          isAutomatedMessage(m.from, m.subject) &&
          !AUTOMATED_SENDER.test(m.from) &&
          mightBeHolidayOoo(text)
        ) {
          const c = await classifyReply(classifyInput);
          if (c.classification === "auto_reply") {
            oooHoliday = c.oooHoliday;
            det.returnDate = c.oooReturnDate;
          }
        }
        det.holiday =
          det.holiday || oooHoliday || Boolean(det.returnDate && inHolidayWindow(det.returnDate));

        if (det.holiday && !hit.leads.some((l) => inquiries.has(l.id))) {
          const resume = holidayResumeDate(det, today);
          if (resume > today) {
            const res = await applyHolidayOoo(admin, {
              leadIds: hit.leads.map((l) => l.id),
              outreachId: hit.outreachId,
              senderEmail: senderAddress(m.from),
              fromName,
              returnDate: det.returnDate,
              resume,
            });
            if (res.applied) {
              if (!res.duplicate) holidayOoo += 1;
              if (res.leadId) {
                updatedLeads.add(res.leadId);
                revalidatePath(`/admin/leads/${res.leadId}`);
              }
              continue;
            }
          }
        }

        // Ordinary auto-reply. Follow-ups continue as scheduled.
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
        if (ambiguous || inquiries.has(l.id)) {
          revalidatePath(`/admin/leads/${l.id}`);
          continue;
        }

        const target: LeadStatus =
          classification === "interested"
            ? "interested"
            : classification === "back_burner"
              ? "back_burner"
              : classification === "cant_pay"
                ? "cant_pay"
                : "not_interested";
        // Never downgrade engagement on a later reply: one interested person
        // keeps the lead Interested even if a colleague later defers or
        // declines, and a Back burner lead isn't closed out by a colleague's
        // decline. The later reply is still in the activity log.
        const downgrade = rank(target) < rank(l.status);
        if (target !== l.status && !PROTECTED.includes(l.status) && !downgrade) {
          await admin.from("leads").update({ status: target }).eq("id", l.id);
          await admin.from("interactions").insert({
            lead_id: l.id,
            kind: "status_change",
            detail: `Status set to ${statusLabel(target)} (auto: reply from ${fromName})${
              target === "back_burner" && revisitOn ? `; revisit on ${revisitOn}` : ""
            }.`,
          });
          l.status = target; // later messages in this run see the new status
          updatedLeads.add(l.id);
        }

        // Revisit date. Runs once per reply: the message is recorded in
        // reply_scan_messages after this run, so rescans never see it again.
        if (!PROTECTED.includes(l.status)) {
          const changed = await applyRevisitForReply(admin, l.id, {
            fromName,
            revisitOn,
            revisitReason,
          });
          if (changed) updatedLeads.add(l.id);
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
      holidayOoo,
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
