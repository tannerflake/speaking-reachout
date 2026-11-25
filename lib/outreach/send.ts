import type { SupabaseClient } from "@supabase/supabase-js";
import { GmailNotConnectedError, sendGmail } from "@/lib/gmail/send";
import { getOutreachOnePager } from "@/lib/gmail/attachments";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  newFollowupContext,
  sendFollowupForSequence,
  startSequence,
  type FollowupContext,
} from "@/lib/followups/run";
import {
  holdMessage,
  sendHoldReason,
  verifyContactIfPossible,
} from "@/lib/contacts/deliverability";
import { attachOnePager, plainEmailProblem } from "@/lib/outreach/plainEmail";
import { dayKey, sendNowVerdict } from "@/lib/outreach/schedule";
import { contactIsOut, prettyDate, resumeEarliestMs } from "@/lib/followups/holiday";
import { slotAfterHoliday } from "@/lib/followups/holidayApply";
import {
  acquireSendLock,
  loadSendLedger,
  orgKeysFor,
  takeSlot,
  tzOfLead,
  type SendLedger,
} from "@/lib/outreach/slots";
import {
  EngagementGuardUnavailableError,
  checkEngagementGuard,
  newGuardBatch,
  markLeadAlreadyInContact,
  type GuardBatch,
  summarizeConflicts,
} from "@/lib/outreach/guard";
import { HONORARIUM_LINE, ensureHonorarium } from "@/lib/outreach/honorarium";
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
  /** The address needs verification first; the draft was kept, not sent. */
  held?: boolean;
  /** The contact is out for the holidays; re-queued for their resume date. */
  postponed?: boolean;
}

/**
 * Park a row as 'blocked' with the reason. Falls back to 'failed' if the
 * database predates migration 0024; either way nothing is sent.
 */
async function markBlocked(
  db: Db,
  outreachId: string,
  leadId: string,
  reason: string,
): Promise<void> {
  await markLeadAlreadyInContact(db, leadId, reason);
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
  opts: { guardBatch?: GuardBatch } = {},
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

  // HOLIDAY OUT-OF-OFFICE. Nothing goes to a contact before their
  // ooo_until date (recipient's local calendar). Re-queue for the first slot
  // on that date; every check below runs again then.
  if (row.contact?.ooo_until) {
    const { data: loc } = await db
      .from("leads")
      .select("location_region, location_country")
      .eq("id", row.lead_id)
      .maybeSingle();
    const tz = tzOfLead(loc as { location_region: string | null; location_country: string | null } | null);
    if (contactIsOut(row.contact, dayKey(Date.now(), tz))) {
      const at = await slotAfterHoliday(
        db,
        { kind: "outreach", id: row.id, leadId: row.lead_id, email, tz },
        row.contact.ooo_until,
      );
      const message = `Not sent yet: ${email} is out for the holidays until ${prettyDate(
        row.contact.ooo_until,
      )}. Rescheduled for ${new Date(at).toUTCString()}.`;
      await db
        .from("outreach")
        .update({ status: "queued", scheduled_for: new Date(at).toISOString(), error: null })
        .eq("id", outreachId);
      return { error: message, leadId: row.lead_id, postponed: true };
    }
  }

  // BOUNCE PROTECTION. Only verified addresses are emailed; a guessed one is
  // held (draft kept), a bounced or invalid one is refused for good. Checked
  // here as well as at queue time: the contact can change while queued.
  let hold = sendHoldReason(row.contact);
  if (hold === "needs_verification" && row.contact) {
    const status = await verifyContactIfPossible(db, row.contact);
    hold = sendHoldReason({ email, contact_status: status });
  }
  if (hold) {
    const message = holdMessage(hold, email);
    await db
      .from("outreach")
      .update({
        status: hold === "needs_verification" ? "draft" : "failed",
        error: message,
        scheduled_for: null,
      })
      .eq("id", outreachId);
    return {
      error: message,
      leadId: row.lead_id,
      held: hold === "needs_verification",
    };
  }

  // One first email per inbox per lead. Two contact rows can carry the same
  // address (the same person found under two names), each with its own
  // draft; once one has gone out, the twin is refused instead of sent.
  if ((row.sequence_step ?? 0) === 0 && row.contact) {
    const { data: twins } = await db
      .from("outreach")
      .select("id, sequence_step, contact:contacts!inner(id, email)")
      .eq("lead_id", row.lead_id)
      .eq("status", "sent")
      .neq("contact_id", row.contact.id)
      .ilike("contact.email", (email as string).trim());
    const alreadySent = ((twins as Array<{ sequence_step: number | null }> | null) ?? []).some(
      (t) => (t.sequence_step ?? 0) === 0,
    );
    if (alreadySent) {
      const message = `Not sent: ${email} was already emailed for this lead through a duplicate contact entry. Delete this duplicate draft.`;
      await db
        .from("outreach")
        .update({ status: "failed", error: message, scheduled_for: null })
        .eq("id", outreachId);
      return { error: message, leadId: row.lead_id };
    }
  }

  // ENGAGEMENT GUARD. Never email an organization we are already talking to,
  // whichever lead row the conversation lives on and even if it lives only in
  // the mailbox. Fails closed. Only an explicit, recorded operator override
  // on this exact row skips it.
  const overridden = Boolean(row.guard_override_at);
  if (!overridden) {
    // Already flagged once: blocked sticks until a human changes the status,
    // whatever today's check would say.
    const { data: leadRow } = await db
      .from("leads")
      .select("status")
      .eq("id", row.lead_id)
      .maybeSingle();
    if ((leadRow as { status: string } | null)?.status === "blocked") {
      const reason = "Already in contact: this lead was flagged by the engagement guard.";
      await markBlocked(db, outreachId, row.lead_id, reason);
      return { error: `Blocked: ${reason}`, leadId: row.lead_id, blocked: true };
    }
    let guard;
    try {
      guard = await checkEngagementGuard(db, row.lead_id, {
        contactEmail: email,
        batch: opts.guardBatch,
      });
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
      await markBlocked(db, outreachId, row.lead_id, reason);
      await db.from("interactions").insert({
        lead_id: row.lead_id,
        kind: "note",
        detail: `Blocked an email to ${email}. ${reason}`,
      });
      return { error: `Blocked: ${reason}`, leadId: row.lead_id, blocked: true };
    }
  }

  // A first email must say this is a paid engagement. Fold the line in if the
  // draft lacks it (older drafts, hand edits); refuse if there's nowhere
  // sensible to put it. Follow-ups are left alone.
  let body = row.body;
  if ((row.sequence_step ?? 0) === 0) {
    const withHonorarium = ensureHonorarium(body);
    if (withHonorarium === null) {
      const message = `Not sent: this first email doesn't mention the honorarium. Add a line such as "${HONORARIUM_LINE}" and send again.`;
      await db
        .from("outreach")
        .update({ status: "failed", error: message, scheduled_for: null })
        .eq("id", outreachId);
      return { error: message, leadId: row.lead_id };
    }
    body = withHonorarium;
  }

  // Plain and personal: no shorteners, no HTML, few links, no promised
  // attachment that isn't there.
  const plainProblem = plainEmailProblem(body, { firstEmail: (row.sequence_step ?? 0) === 0 });
  if (plainProblem) {
    await db
      .from("outreach")
      .update({ status: "failed", error: plainProblem, scheduled_for: null })
      .eq("id", outreachId);
    return { error: plainProblem, leadId: row.lead_id };
  }

  try {
    // No attachment: a PDF from a stranger is one of the strongest spam
    // signals. OUTREACH_ATTACH_ONE_PAGER=true restores the old one-pager.
    const attachments =
      (row.sequence_step ?? 0) === 0 && attachOnePager() ? [await getOutreachOnePager()] : [];
    const result = await sendGmail({
      to: email as string,
      subject: row.subject,
      body,
      attachments,
    });

    const sentAt = new Date().toISOString();
    await db
      .from("outreach")
      .update({
        status: "sent",
        body,
        gmail_message_id: result.messageId,
        gmail_thread_id: result.threadId,
        sent_at: sentAt,
        scheduled_for: null,
        error: null,
      })
      .eq("id", outreachId);

    // Auto-advance only from 'new' (or 'blocked', for an override send) so a
    // later-stage lead is never downgraded.
    await db
      .from("leads")
      .update({ status: "reached_out" })
      .eq("id", row.lead_id)
      .in("status", ["new", "blocked"]);

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
    // Referred contacts are handled by hand: no automated nudges.
    if ((row.sequence_step ?? 0) === 0 && !row.contact?.referred_by_contact_id) {
      const firstAt = await startSequence(
        createAdminClient(),
        { id: row.id, lead_id: row.lead_id, contact_id: row.contact_id, sent_at: sentAt },
        { email },
      );
      await db.from("interactions").insert({
        lead_id: row.lead_id,
        kind: "note",
        detail: `Follow-ups scheduled for ${email}: 3 nudges in the same thread, roughly days 4, 11, and 21, unless they reply first${
          firstAt ? `; the first is set for ${new Date(firstAt).toUTCString()}` : ""
        }.`,
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


// --- Scheduled queue ---------------------------------------------------------
//
// Nothing is sent the moment it is approved. Approving (one draft, a lead's
// "send all", or the Leads page bulk send) puts each email in the queue with
// a scheduled time picked by lib/outreach/schedule.ts: weekday business hours
// in the recipient's time zone, 2-6 minutes between any two sends, hourly and
// daily caps, and colleagues at one organization at least 45 minutes apart.
// A tick (runSendTick) runs every minute and sends at most one email.

export interface QueueResult {
  queued: number;
  /** No usable email address at all. */
  skipped: number;
  /** Drafts refused by the engagement guard (org already in conversation). */
  blocked: number;
  /** Guessed / unconfirmed addresses held back; their drafts are kept. */
  needsVerification: number;
  /** Addresses that bounced or the verifier rejected; never sent. */
  undeliverable: number;
  /** Addresses the verifier confirmed during this queueing run. */
  verified: number;
  /** Drafts that need an edit first (attachment promise, shortener, links). */
  needsEdit: number;
  firstAt: string | null;
  finishesAt: string | null;
  error?: string;
}

const EMPTY_QUEUE: QueueResult = {
  queued: 0,
  skipped: 0,
  blocked: 0,
  needsVerification: 0,
  undeliverable: 0,
  verified: 0,
  needsEdit: 0,
  firstAt: null,
  finishesAt: null,
};

type QueueRow = {
  id: string;
  lead_id: string;
  body: string;
  sequence_step: number | null;
  guard_override_at: string | null;
  contact: Contact | null;
  lead: { location_region: string | null; location_country: string | null } | null;
};

/**
 * Put unsent drafts (draft or failed) into the send queue with scheduled
 * times. Select by lead (bulk send, a lead's "send all") or by outreach id (a
 * single approval). Holds back unverified addresses (verifying them first when
 * a verifier is configured), refuses bounced ones, and runs the engagement
 * guard preflight. Nothing is sent here.
 */
export async function queueOutreach(
  db: Db,
  select: { leadIds?: string[]; outreachIds?: string[] },
): Promise<QueueResult> {
  const leadIds = select.leadIds ?? [];
  const outreachIds = select.outreachIds ?? [];
  if (leadIds.length === 0 && outreachIds.length === 0) return { ...EMPTY_QUEUE };

  let q = db
    .from("outreach")
    .select(
      "id, lead_id, body, sequence_step, guard_override_at, contact:contacts(*), lead:leads(location_region, location_country)",
    )
    .in("status", ["draft", "failed"]);
  q = outreachIds.length ? q.in("id", outreachIds) : q.in("lead_id", leadIds);
  const { data, error } = await q;
  if (error) return { ...EMPTY_QUEUE, error: error.message };

  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
  const rows = ((data as unknown as QueueRow[] | null) ?? []).map((r) => ({
    ...r,
    contact: one(r.contact as Contact | Contact[] | null),
    lead: one(r.lead as QueueRow["lead"] | QueueRow["lead"][] | null),
  }));
  const result: QueueResult = { ...EMPTY_QUEUE };

  // 0. Bulk runs (by lead) never schedule a referred contact: someone at the
  // org pointed us to them and Jeff/Cheryl write to them by hand. A draft
  // picked explicitly (by id) still goes through the engagement guard.
  const candidates = rows.filter((r) => {
    const referred =
      outreachIds.length === 0 &&
      !r.guard_override_at &&
      !!(r.contact as { referred_by_contact_id?: string | null } | null)?.referred_by_contact_id;
    if (referred) result.blocked += 1;
    return !referred;
  });

  // 1. Deliverability: verified addresses only.
  const verifiedNow = new Map<string, Contact["contact_status"]>();
  const deliverable: typeof rows = [];
  for (const r of candidates) {
    let hold = sendHoldReason(r.contact);
    if (hold === "needs_verification" && r.contact) {
      let status = verifiedNow.get(r.contact.id);
      if (!status) {
        status = await verifyContactIfPossible(db, r.contact);
        verifiedNow.set(r.contact.id, status);
        if (status === "verified") result.verified += 1;
      }
      hold = sendHoldReason({ email: r.contact.email, contact_status: status });
    }
    if (!hold) {
      deliverable.push(r);
      continue;
    }
    if (hold === "no_email") result.skipped += 1;
    else if (hold === "needs_verification") result.needsVerification += 1;
    else {
      result.undeliverable += 1;
      await db
        .from("outreach")
        .update({ status: "failed", error: holdMessage(hold, r.contact?.email) })
        .eq("id", r.id);
    }
  }

  // 2. Plain-email check, so a draft that would be refused at send time is
  // flagged now instead of silently failing later in the day.
  const plain: typeof rows = [];
  for (const r of deliverable) {
    const problem = plainEmailProblem(r.body, { firstEmail: (r.sequence_step ?? 0) === 0 });
    if (problem) {
      result.needsEdit += 1;
      await db.from("outreach").update({ status: "failed", error: problem }).eq("id", r.id);
    } else plain.push(r);
  }

  // 3. Engagement guard preflight (CRM only; the mailbox is checked again at
  // send time). Blocked drafts are parked now so the operator sees it at
  // once instead of discovering it in the queue later.
  const ready: typeof rows = [];
  const verdicts = new Map<string, { blocked: boolean; reason: string }>();
  const plainLeadIds = [...new Set(plain.map((r) => r.lead_id))];
  if (plainLeadIds.length) {
    // Leads already flagged stay out, whatever today's check says.
    const { data: flagged } = await db
      .from("leads")
      .select("id")
      .in("id", plainLeadIds)
      .eq("status", "blocked");
    for (const l of (flagged ?? []) as Array<{ id: string }>) {
      verdicts.set(l.id, {
        blocked: true,
        reason: "Already in contact: this lead was flagged by the engagement guard.",
      });
    }
  }
  for (const r of plain) {
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
      result.blocked += 1;
      await markBlocked(db, r.id, r.lead_id, v.reason);
      await db.from("interactions").insert({
        lead_id: r.lead_id,
        kind: "note",
        detail: `Blocked an email to ${r.contact?.email}. ${v.reason}`,
      });
    } else {
      ready.push(r);
    }
  }
  if (ready.length === 0) return result;

  // 4. Schedule. Round-robin across organizations (everyone's first contact,
  // then everyone's second, ...) so the day interleaves orgs; the allocator
  // still enforces spacing and per-org caps.
  let ledger: SendLedger;
  try {
    ledger = await loadSendLedger(db);
  } catch (e) {
    return { ...result, error: e instanceof Error ? e.message : "Could not load the schedule." };
  }
  const byLead = new Map<string, typeof rows>();
  for (const r of ready) byLead.set(r.lead_id, [...(byLead.get(r.lead_id) ?? []), r]);
  const ordered: typeof rows = [];
  for (let i = 0; ordered.length < ready.length; i += 1) {
    for (const list of byLead.values()) if (list[i]) ordered.push(list[i]);
  }

  const earliest = Date.now() + 2 * 60_000;
  let first = Infinity;
  let last = 0;
  for (const r of ordered) {
    // A contact out for the holidays waits until their resume date.
    const tz = tzOfLead(r.lead);
    const start = contactIsOut(r.contact, dayKey(Date.now(), tz))
      ? Math.max(earliest, resumeEarliestMs(r.contact?.ooo_until as string, tz))
      : earliest;
    const at = takeSlot(
      ledger,
      {
        kind: "outreach",
        id: r.id,
        leadId: r.lead_id,
        email: r.contact?.email ?? null,
        tz,
      },
      start,
    );
    first = Math.min(first, at);
    last = Math.max(last, at);
    await db
      .from("outreach")
      .update({ status: "queued", scheduled_for: new Date(at).toISOString(), error: null })
      .eq("id", r.id);
    result.queued += 1;
  }
  return {
    ...result,
    firstAt: new Date(first).toISOString(),
    finishesAt: new Date(last).toISOString(),
  };
}

/** Back-compat wrapper for the Leads page bulk send. */
export function queueOutreachForLeads(db: Db, leadIds: string[]): Promise<QueueResult> {
  return queueOutreach(db, { leadIds });
}

export interface TickResult {
  sent: number;
  failed: number;
  /** Refused by the engagement guard (parked as blocked, not retried). */
  blocked: number;
  /** Left queued because the mailbox could not be checked; retried later. */
  deferred: number;
  /** Pulled back to draft: the address needs verification. */
  held: number;
  /** Due items moved to a new slot (outside hours, a cap, org spacing). */
  rescheduled: number;
  followupsSent: number;
  followupsStopped: number;
  remaining: number;
  nextDueAt: string | null;
  /** Another tick was already running; this one did nothing. */
  busy: boolean;
  /** Why nothing went out on this tick, when something was due. */
  waiting: string | null;
  errors: string[];
}

type DueItem = {
  kind: "outreach" | "followup";
  id: string;
  leadId: string;
  due: string;
  email: string | null;
  tz: string;
};

/**
 * One pass of the send queue: look at everything due (queued first emails and
 * follow-ups whose time has come) and send AT MOST `maxSends` of them, after
 * checking the pacing rules against what has actually gone out. Due items that
 * can't go now because of the clock (outside the recipient's hours, a daily
 * cap, a colleague emailed minutes ago) get a fresh slot; items held only by
 * the 2-minute gap or the hourly cap simply wait for the next tick.
 *
 * Every send goes through the full checks: engagement guard (with the live
 * mailbox), duplicate-first-email refusal, verification, Gmail quota backoff.
 */
export async function runSendTick(db: Db, opts: { maxSends?: number } = {}): Promise<TickResult> {
  const maxSends = opts.maxSends ?? 1;
  const out: TickResult = {
    sent: 0,
    failed: 0,
    blocked: 0,
    deferred: 0,
    held: 0,
    rescheduled: 0,
    followupsSent: 0,
    followupsStopped: 0,
    remaining: 0,
    nextDueAt: null,
    busy: false,
    waiting: null,
    errors: [],
  };

  const release = await acquireSendLock(db);
  if (!release) return { ...out, busy: true, ...(await queueTail(db)) };
  try {
    const nowIso = new Date().toISOString();
    type Row = {
      id: string;
      lead_id: string;
      due: string;
      contact: { email: string | null } | { email: string | null }[] | null;
      lead:
        | { location_region: string | null; location_country: string | null }
        | { location_region: string | null; location_country: string | null }[]
        | null;
    };
    const [queuedRes, seqRes] = await Promise.all([
      db
        .from("outreach")
        .select("id, lead_id, due:scheduled_for, contact:contacts(email), lead:leads(location_region, location_country)")
        .eq("status", "queued")
        .lte("scheduled_for", nowIso)
        .order("scheduled_for", { ascending: true })
        .limit(25),
      db
        .from("followup_sequences")
        .select("id, lead_id, due:next_due_at, contact:contacts(email), lead:leads(location_region, location_country)")
        .eq("status", "active")
        .lte("next_due_at", nowIso)
        .order("next_due_at", { ascending: true })
        .limit(25),
    ]);
    if (queuedRes.error) throw new Error(queuedRes.error.message);
    if (seqRes.error) throw new Error(seqRes.error.message);
    const toItem = (kind: DueItem["kind"]) => (r: Row): DueItem => {
      const contact = Array.isArray(r.contact) ? (r.contact[0] ?? null) : r.contact;
      return { kind, id: r.id, leadId: r.lead_id, due: r.due, email: contact?.email ?? null, tz: tzOfLead(r.lead) };
    };
    const due = [
      ...((queuedRes.data ?? []) as unknown as Row[]).map(toItem("outreach")),
      ...((seqRes.data ?? []) as unknown as Row[]).map(toItem("followup")),
    ].sort((a, b) => a.due.localeCompare(b.due));
    if (due.length === 0) return { ...out, ...(await queueTail(db)) };

    const ledger = await loadSendLedger(db);
    const guardBatch = newGuardBatch();
    let followupCtx: FollowupContext | null = null;
    let sends = 0;

    for (const item of due) {
      const orgKeys = orgKeysFor(item.leadId, item.email);
      const verdict = sendNowVerdict(Date.now(), item.tz, orgKeys, ledger.sent);

      if (!verdict.ok) {
        if (verdict.action === "wait") {
          out.waiting ??= verdict.reason;
          continue;
        }
        const at = takeSlot(ledger, item, Date.now() + 60_000);
        await moveItem(db, item, at);
        out.rescheduled += 1;
        continue;
      }
      if (sends >= maxSends) {
        out.waiting ??= "One email per tick; the rest go out on the next ticks.";
        continue;
      }

      // Claim before sending: several tick sources can race (the lock covers
      // most of it; this covers the database without migration 0031). If this
      // process dies mid-send the item becomes due again in an hour.
      const claimed = await claimItem(db, item, nowIso);
      if (!claimed) continue;

      if (item.kind === "outreach") {
        const res = await sendOutreachRow(db, item.id, { guardBatch });
        if (res.ok) {
          out.sent += 1;
          sends += 1;
          ledger.sent.push({ at: Date.now(), orgKeys });
        } else if (res.blocked) {
          out.blocked += 1;
          if (res.error) out.errors.push(res.error);
        } else if (res.held) {
          out.held += 1;
          if (res.error) out.errors.push(res.error);
        } else if (res.postponed) {
          out.rescheduled += 1;
        } else if (res.deferred) {
          // Keep it queued, not due again for ten minutes, so a mailbox hiccup
          // doesn't spin on the same row.
          out.deferred += 1;
          await db
            .from("outreach")
            .update({ scheduled_for: new Date(Date.now() + 10 * 60_000).toISOString() })
            .eq("id", item.id)
            .eq("status", "queued");
          if (res.error) out.errors.push(res.error);
          break; // the mailbox is unavailable; the rest would fail the same way
        } else {
          out.failed += 1;
          if (res.error) out.errors.push(res.error);
        }
      } else {
        followupCtx ??= await newFollowupContext(createAdminClient(), guardBatch);
        try {
          const outcome = await sendFollowupForSequence(createAdminClient(), item.id, followupCtx);
          if (outcome === "sent") {
            out.followupsSent += 1;
            sends += 1;
            ledger.sent.push({ at: Date.now(), orgKeys });
          } else if (outcome === "stopped") out.followupsStopped += 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Follow-up failed.";
          out.errors.push(msg);
          // Try again in 15 minutes rather than an hour.
          await createAdminClient()
            .from("followup_sequences")
            .update({ last_error: msg, next_due_at: new Date(Date.now() + 15 * 60_000).toISOString() })
            .eq("id", item.id)
            .eq("status", "active");
          if (/mailbox|gmail|connect/i.test(msg)) break;
        }
      }
    }
    return { ...out, ...(await queueTail(db)) };
  } finally {
    await release();
  }
}

async function claimItem(db: Db, item: DueItem, nowIso: string): Promise<boolean> {
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  if (item.kind === "outreach") {
    const { data } = await db
      .from("outreach")
      .update({ scheduled_for: later })
      .eq("id", item.id)
      .eq("status", "queued")
      .lte("scheduled_for", nowIso)
      .select("id");
    return Boolean(data && data.length);
  }
  const { data } = await createAdminClient()
    .from("followup_sequences")
    .update({ next_due_at: later })
    .eq("id", item.id)
    .eq("status", "active")
    .lte("next_due_at", nowIso)
    .select("id");
  return Boolean(data && data.length);
}

async function moveItem(db: Db, item: DueItem, at: number): Promise<void> {
  const iso = new Date(at).toISOString();
  if (item.kind === "outreach") {
    await db.from("outreach").update({ scheduled_for: iso }).eq("id", item.id).eq("status", "queued");
  } else {
    await createAdminClient()
      .from("followup_sequences")
      .update({ next_due_at: iso })
      .eq("id", item.id)
      .eq("status", "active");
  }
}

async function queueTail(db: Db): Promise<{ remaining: number; nextDueAt: string | null }> {
  const { count } = await db
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
    remaining: count ?? 0,
    nextDueAt: (next as { scheduled_for: string | null } | null)?.scheduled_for ?? null,
  };
}

export interface QueueStatus {
  queued: number;
  due: number;
  nextDueAt: string | null;
  lastDueAt: string | null;
  /** Follow-ups scheduled from now through the end of tomorrow. */
  followupsSoon: number;
}

export async function getQueueStatus(db: Db): Promise<QueueStatus> {
  const nowIso = new Date().toISOString();
  const soonIso = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
  const [queued, due, first, last, followups] = await Promise.all([
    db.from("outreach").select("id", { count: "exact", head: true }).eq("status", "queued"),
    db
      .from("outreach")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued")
      .lte("scheduled_for", nowIso),
    db
      .from("outreach")
      .select("scheduled_for")
      .eq("status", "queued")
      .order("scheduled_for", { ascending: true })
      .limit(1)
      .maybeSingle(),
    db
      .from("outreach")
      .select("scheduled_for")
      .eq("status", "queued")
      .order("scheduled_for", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("followup_sequences")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .lte("next_due_at", soonIso),
  ]);
  return {
    queued: queued.count ?? 0,
    due: due.count ?? 0,
    nextDueAt: (first.data as { scheduled_for: string | null } | null)?.scheduled_for ?? null,
    lastDueAt: (last.data as { scheduled_for: string | null } | null)?.scheduled_for ?? null,
    followupsSoon: followups.count ?? 0,
  };
}
