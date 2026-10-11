import type { SupabaseClient } from "@supabase/supabase-js";
import { GmailNotConnectedError, sendGmail } from "@/lib/gmail/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { startSequence } from "@/lib/followups/run";
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
export async function sendOutreachRow(
  db: Db,
  outreachId: string,
): Promise<{ error?: string; ok?: boolean; leadId?: string }> {
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

  try {
    const result = await sendGmail({
      to: email as string,
      subject: row.subject,
      body: row.body,
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
      detail: `Sent "${row.subject}" to ${email}.`,
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
  if (leadIds.length === 0) return { queued: 0, skipped: 0, finishesAt: null };

  const { data, error } = await db
    .from("outreach")
    .select("id, lead_id, contact:contacts(email)")
    .in("lead_id", leadIds)
    .in("status", ["draft", "failed"]);
  if (error) return { queued: 0, skipped: 0, finishesAt: null, error: error.message };

  // Supabase types the to-one join as an array; it is a single object at runtime.
  type Row = { id: string; lead_id: string; contact: { email: string | null } | { email: string | null }[] | null };
  const rows = ((data as unknown as Row[] | null) ?? []).map((r) => ({
    ...r,
    contact: Array.isArray(r.contact) ? (r.contact[0] ?? null) : r.contact,
  }));
  const ready = rows.filter((r) => looksLikeRealEmail(r.contact?.email));
  const skipped = rows.length - ready.length;
  if (ready.length === 0) return { queued: 0, skipped, finishesAt: null };

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

  return { queued: ready.length, skipped, finishesAt: new Date(last).toISOString() };
}

export interface DrainResult {
  sent: number;
  failed: number;
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
      const res = await sendOutreachRow(db, row.id);
      if (res.ok) sent += 1;
      else {
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
