import type { SupabaseClient } from "@supabase/supabase-js";
import { GmailNotConnectedError, sendGmail } from "@/lib/gmail/send";
import { getOutreachOnePager } from "@/lib/gmail/attachments";
import { createAdminClient } from "@/lib/supabase/admin";
import { startSequence } from "@/lib/followups/run";
import {
  EngagementGuardUnavailableError,
  checkEngagementGuard,
  summarizeConflicts,
} from "@/lib/outreach/guard";
import { looksLikeRealEmail } from "@/lib/utils";
import type { Contact, Outreach } from "@/lib/types";

// Any Supabase client works here: the cookie-bound one from a server action or
// the service-role one from the cron route. Both share the query API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * Send one outreach row and record the result: status, Gmail IDs, lead
 * auto-advance to reached_out, activity log, and the follow-up sequence.
 * This is the single send path; approveAndSend, sendAllDrafts, and the queue
 * drainer all go through it.
 */
export interface SendRowResult {
  error?: string;
  ok?: boolean;
  leadId?: string;
  /** The engagement guard refused: the org is already in a conversation. */
  blocked?: boolean;
  /** The guard could not run (mailbox unavailable); nothing was sent and the
   * row was left as it was so it can be retried. */
  deferred?: boolean;
}

/**
 * Park a row as 'blocked' with the reason. Falls back to 'failed' if the
 * database predates migration 0024; either way nothing is sent.
 */
async function markBlocked(db: Db, outreachId: string, reason: string): Promise<void> {
  const { error } = await db
    .from("outreach")
    .update({ status: "blocked", error: reason, scheduled_for: null })
    .eq("id", outreachId);
  if (error) {
    await db
      .from("outreach")
      .update({ status: "failed", error: `BLOCKED: ${reason}`, scheduled_for: null })
      .eq("id", outreachId);
  }
}

export async function sendOutreachRow(
  db: Db,
  outreachId: string,
): Promise<SendRowResult> {
  const { data } = await db
    .from("outreach")
    .select("*, contact:contacts(*)")
    .eq("id", outreachId)
    .single();
  if (!data) return { error: "Draft not found." };

  const row = data as Outreach & { contact: Contact | null };
  if (row.status === "sent") return { error: "Already sent.", leadId: row.lead_id };

  const email = row.contact?.email ?? null;
  if (!looksLikeRealEmail(email)) {
    await db
      .from("outreach")
      .update({ status: "failed", error: "No valid contact email.", scheduled_for: null })
      .eq("id", outreachId);
    return {
      error:
        "No valid contact email on this outreach. Resolve the contact's email before sending.",
      leadId: row.lead_id,
    };
  }

  // ENGAGEMENT GUARD. Never email an organization we are already talking to,
  // whichever lead row the conversation lives on and even if it lives only in
  // the mailbox. Fails closed. Only an explicit, recorded operator override
  // on this exact row skips it.
  const overridden = Boolean(row.guard_override_at);
  if (!overridden) {
    let guard;
    try {
      guard = await checkEngagementGuard(db, row.lead_id, { contactEmail: email });
    } catch (e) {
      if (e instanceof EngagementGuardUnavailableError) {
        await db.from("outreach").update({ error: e.message }).eq("id", outreachId);
        return {
          error: `Not sent. Could not confirm there is no existing conversation: ${e.message}`,
          leadId: row.lead_id,
          deferred: true,
        };
      }
      throw e;
    }
    if (guard.blocked) {
      const reason = summarizeConflicts(guard);
      await markBlocked(db, outreachId, reason);
      await db.from("interactions").insert({
        lead_id: row.lead_id,
        kind: "note",
        detail: `Blocked an email to ${email}. ${reason}`,
      });
      return { error: `Blocked: ${reason}`, leadId: row.lead_id, blocked: true };
    }
  }

  try {
    // Every initial outreach carries the one-page speaking overview; the
    // email copy refers to it, so sending without it would be a broken
    // promise. Follow-ups (lib/followups/run.ts) deliberately do not.
    const onePager = await getOutreachOnePager();
    const result = await sendGmail({
      to: email as string,
      subject: row.subject,
      body: row.body,
      attachments: [onePager],
    });

    const sentAt = new Date().toISOString();
    await db
      .from("outreach")
      .update({
        status: "sent",
        gmail_message_id: result.messageId,
        gmail_thread_id: result.threadId,
        sent_at: sentAt,
        scheduled_for: null,
        error: null,
      })
      .eq("id", outreachId);

    // Auto-advance only from 'new' so a later-stage lead is never downgraded.
    await db
      .from("leads")
      .update({ status: "reached_out" })
      .eq("id", row.lead_id)
      .eq("status", "new");

    await db.from("interactions").insert({
      lead_id: row.lead_id,
      kind: "email_sent",
      detail: overridden
        ? `Sent "${row.subject}" to ${email} with an engagement-guard override: ${row.guard_override_reason ?? "no reason given"}.`
        : `Sent "${row.subject}" to ${email}.`,
    });

    // Every initial outreach gets an automated follow-up sequence (up to 3
    // nudges in the same thread; see lib/followups/cadence.ts). Follow-ups
    // themselves (sequence_step > 0) never start a new sequence.
    if ((row.sequence_step ?? 0) === 0) {
      await startSequence(createAdminClient(), {
        id: row.id,
        lead_id: row.lead_id,
        contact_id: row.contact_id,
        sent_at: sentAt,
      });
      await db.from("interactions").insert({
        lead_id: row.lead_id,
        kind: "note",
        detail: `Follow-ups scheduled for ${email}: 3 nudges in the same thread, roughly days 4, 11, and 21, unless they reply first.`,
      });
    }

    return { ok: true, leadId: row.lead_id };
  } catch (e) {
    const message =
      e instanceof GmailNotConnectedError
        ? e.message
        : e instanceof Error
          ? e.message
          : "Send failed.";
    await db
      .from("outreach")
      .update({ status: "failed", error: message, scheduled_for: null })
      .eq("id", outreachId);
    return { error: message, leadId: row.lead_id };
  }
}

// --- Throttled queue ---------------------------------------------------------

/** Minimum gap between two queued sends, whatever spread was asked for. */
export const MIN_GAP_SECONDS = 20;
/** Default pace: about one email a minute. */
export const DEFAULT_GAP_SECONDS = 60;
/**
 * Safety cap on queued sends per rolling 24 hours. Google Workspace allows
 * 2,000 a day; staying far below keeps the account off the radar.
 */
export const DAILY_SEND_CAP = 300;

export interface QueueResult {
  queued: number;
  skipped: number;
  /** Drafts refused by the engagement guard (org already in conversation). */
  blocked: number;
  finishesAt: string | null;
  error?: string;
}

/**
 * Put every unsent draft (draft or failed) with a valid contact email on the
 * given leads into the send queue, spread evenly over `spreadMinutes` with a
 * little jitter so sends don't land on a metronome. Nothing is sent here.
 */
export async function queueOutreachForLeads(
  db: Db,
  leadIds: string[],
  spreadMinutes: number,
): Promise<QueueResult> {
  if (leadIds.length === 0) return { queued: 0, skipped: 0, blocked: 0, finishesAt: null };

  const { data, error } = await db
    .from("outreach")
    .select("id, lead_id, guard_override_at, contact:contacts(email)")
    .in("lead_id", leadIds)
    .in("status", ["draft", "failed"]);
  if (error) return { queued: 0, skipped: 0, blocked: 0, finishesAt: null, error: error.message };

  // Supabase types the to-one join as an array; it is a single object at runtime.
  type Row = {
    id: string;
    lead_id: string;
    guard_override_at: string | null;
    contact: { email: string | null } | { email: string | null }[] | null;
  };
  const rows = ((data as unknown as Row[] | null) ?? []).map((r) => ({
    ...r,
    contact: Array.isArray(r.contact) ? (r.contact[0] ?? null) : r.contact,
  }));
  const withEmail = rows.filter((r) => looksLikeRealEmail(r.contact?.email));
  const skipped = rows.length - withEmail.length;

  // Engagement guard preflight (CRM only; the mailbox is checked again at
  // send time). Blocked drafts are parked now so the operator sees it at
  // once instead of discovering it in the queue later.
  let blocked = 0;
  const ready: typeof withEmail = [];
  const verdicts = new Map<string, { blocked: boolean; reason: string }>();
  for (const r of withEmail) {
    if (r.guard_override_at) {
      ready.push(r);
      continue;
    }
    let v = verdicts.get(r.lead_id);
    if (!v) {
      const g = await checkEngagementGuard(db, r.lead_id, { skipGmail: true });
      v = { blocked: g.blocked, reason: summarizeConflicts(g) };
      verdicts.set(r.lead_id, v);
    }
    if (v.blocked) {
      blocked += 1;
      await markBlocked(db, r.id, v.reason);
      await db.from("interactions").insert({
        lead_id: r.lead_id,
        kind: "note",
        detail: `Blocked an email to ${r.contact?.email}. ${v.reason}`,
      });
    } else {
      ready.push(r);
    }
  }
  if (ready.length === 0) return { queued: 0, skipped, blocked, finishesAt: null };

  // Start after whatever is already queued so two batches don't overlap.
  const { data: tail } = await db
    .from("outreach")
    .select("scheduled_for")
    .eq("status", "queued")
    .order("scheduled_for", { ascending: false })
    .limit(1)
    .maybeSingle();
  const tailAt = (tail as { scheduled_for: string | null } | null)?.scheduled_for;
  const start = Math.max(Date.now(), tailAt ? new Date(tailAt).getTime() + MIN_GAP_SECONDS * 1000 : 0);

  const gapMs = Math.max(
    MIN_GAP_SECONDS * 1000,
    Math.floor((Math.max(1, spreadMinutes) * 60 * 1000) / ready.length),
  );

  let last = start;
  for (let i = 0; i < ready.length; i += 1) {
    const jitter = Math.floor(Math.random() * gapMs * 0.3);
    const at = i === 0 ? start : last + gapMs + jitter;
    last = at;
    await db
      .from("outreach")
      .update({ status: "queued", scheduled_for: new Date(at).toISOString(), error: null })
      .eq("id", ready[i].id);
  }

  return { queued: ready.length, skipped, blocked, finishesAt: new Date(last).toISOString() };
}

export interface DrainResult {
  sent: number;
  failed: number;
  /** Refused by the engagement guard (parked as blocked, not retried). */
  blocked: number;
  /** Left queued because the mailbox could not be checked; retried later. */
  deferred: number;
  remaining: number;
  nextDueAt: string | null;
  capped: boolean;
  errors: string[];
}

/**
 * Send every queued email whose time has come, oldest first, up to `limit`
 * per call so a single invocation stays well inside function time limits.
 * Safe to call from anywhere, as often as you like: the Leads page polls it
 * while open, and the cron route calls it on a schedule.
 */
export async function sendDueQueued(db: Db, limit = 10): Promise<DrainResult> {
  const nowIso = new Date().toISOString();
  const errors: string[] = [];
  let sent = 0;
  let failed = 0;
  let blocked = 0;
  let deferred = 0;
  let capped = false;

  // Rolling daily cap.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: sentToday } = await db
    .from("outreach")
    .select("id", { count: "exact", head: true })
    .eq("status", "sent")
    .gte("sent_at", since);
  const room = Math.max(0, DAILY_SEND_CAP - (sentToday ?? 0));

  if (room > 0) {
    const { data } = await db
      .from("outreach")
      .select("id")
      .eq("status", "queued")
      .lte("scheduled_for", nowIso)
      .order("scheduled_for", { ascending: true })
      .limit(Math.min(limit, room));
    for (const row of (data as Array<{ id: string }> | null) ?? []) {
      // Claim the row before sending. Several drainers run at once (the Leads
      // page poll, the cron, a second open tab) and without this two of them
      // can pick up the same due row and the recipient gets the email twice.
      // The conditional update is atomic: only one caller sees a row back.
      // If this process dies mid-send the row becomes due again in an hour.
      const { data: claimed } = await db
        .from("outreach")
        .update({ scheduled_for: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
        .eq("id", row.id)
        .eq("status", "queued")
        .lte("scheduled_for", nowIso)
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      const res = await sendOutreachRow(db, row.id);
      if (res.ok) sent += 1;
      else if (res.blocked) {
        blocked += 1;
        if (res.error) errors.push(res.error);
      } else if (res.deferred) {
        // Keep it queued, but not due again for ten minutes, so a mailbox
        // hiccup doesn't spin on the same row.
        deferred += 1;
        await db
          .from("outreach")
          .update({ scheduled_for: new Date(Date.now() + 10 * 60 * 1000).toISOString() })
          .eq("id", row.id)
          .eq("status", "queued");
        if (res.error) errors.push(res.error);
        break; // the mailbox is unavailable; the rest will fail the same way
      } else {
        failed += 1;
        if (res.error) errors.push(res.error);
      }
      // A short breath between sends inside one call.
      await new Promise((r) => setTimeout(r, 1500));
    }
  } else {
    capped = true;
  }

  const { count: remaining } = await db
    .from("outreach")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");
  const { data: next } = await db
    .from("outreach")
    .select("scheduled_for")
    .eq("status", "queued")
    .order("scheduled_for", { ascending: true })
    .limit(1)
    .maybeSingle();

  return {
    sent,
    failed,
    blocked,
    deferred,
    remaining: remaining ?? 0,
    nextDueAt: (next as { scheduled_for: string | null } | null)?.scheduled_for ?? null,
    capped,
    errors,
  };
}

export interface QueueStatus {
  queued: number;
  due: number;
  nextDueAt: string | null;
  lastDueAt: string | null;
}

export async function getQueueStatus(db: Db): Promise<QueueStatus> {
  const nowIso = new Date().toISOString();
  const { count: queued } = await db
    .from("outreach")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");
  const { count: due } = await db
    .from("outreach")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued")
    .lte("scheduled_for", nowIso);
  const { data: first } = await db
    .from("outreach")
    .select("scheduled_for")
    .eq("status", "queued")
    .order("scheduled_for", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: last } = await db
    .from("outreach")
    .select("scheduled_for")
    .eq("status", "queued")
    .order("scheduled_for", { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    queued: queued ?? 0,
    due: due ?? 0,
    nextDueAt: (first as { scheduled_for: string | null } | null)?.scheduled_for ?? null,
    lastDueAt: (last as { scheduled_for: string | null } | null)?.scheduled_for ?? null,
  };
}
