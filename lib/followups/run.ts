import { createAdminClient } from "@/lib/supabase/admin";
import { generateFollowup } from "@/lib/claude/followup";
import { GmailNotConnectedError, sendGmail } from "@/lib/gmail/send";
import { getThreadState } from "@/lib/gmail/thread";
import {
  EngagementGuardUnavailableError,
  checkEngagementGuard,
  newGuardBatch,
  summarizeConflicts,
  type GuardBatch,
} from "@/lib/outreach/guard";
import { looksLikeRealEmail, statusLabel } from "@/lib/utils";
import { scanInboxForReplies, type ScanSummary } from "@/lib/gmail/replyScan";
import {
  stopFollowupsForOrganization,
  stopSequencesForLead,
} from "@/lib/followups/stop";
import {
  FOLLOWUP_ELIGIBLE_STATUSES,
  MAX_FOLLOWUPS,
  followupEarliest,
  followupStatusForStep,
  stepOfStatus,
} from "@/lib/followups/cadence";
import { loadSendLedger, takeSlot, tzOfLead } from "@/lib/outreach/slots";
import { dayKey } from "@/lib/outreach/schedule";
import { HOLIDAY_REASON_PREFIX, contactIsOut } from "@/lib/followups/holiday";
import { slotAfterHoliday } from "@/lib/followups/holidayApply";
import { markAddressBounced } from "@/lib/contacts/deliverability";
import { looksLikeDeliveryFailure } from "@/lib/gmail/bounce";
import type {
  Contact,
  FollowupSequence,
  Lead,
  LeadStatus,
  Outreach,
  TailoringRule,
} from "@/lib/types";

// All follow-up work runs through the service-role client: the scheduler has
// no user session, and the same code path is used by the operator's buttons.

export interface RunSummary {
  checked: number;
  sent: number;
  stopped: number;
  errors: string[];
  /** The inbox scan that runs before any follow-up goes out. */
  replyScan?: ScanSummary;
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The exact send slot for follow-up `step` of a sequence: the cadence gives
 * the earliest day (days after the previous email, in the recipient's time
 * zone), and the send schedule (lib/outreach/schedule.ts) picks a business-hour
 * slot on or after it that fits the mailbox's pacing and caps.
 */
export async function planFollowupSlot(
  admin: Admin,
  seq: { id: string; lead_id: string },
  opts: { earliest: number; email?: string | null },
): Promise<number> {
  const [{ data: lead }, ledger] = await Promise.all([
    admin
      .from("leads")
      .select("location_region, location_country")
      .eq("id", seq.lead_id)
      .maybeSingle(),
    loadSendLedger(admin),
  ]);
  return takeSlot(
    ledger,
    {
      kind: "followup",
      id: seq.id,
      leadId: seq.lead_id,
      email: opts.email ?? null,
      tz: tzOfLead(lead as { location_region: string | null; location_country: string | null } | null),
    },
    opts.earliest,
  );
}

async function leadTz(admin: Admin, leadId: string): Promise<string> {
  const { data } = await admin
    .from("leads")
    .select("location_region, location_country")
    .eq("id", leadId)
    .maybeSingle();
  return tzOfLead(data as { location_region: string | null; location_country: string | null } | null);
}

/**
 * Start a follow-up sequence for a just-sent initial outreach, with the first
 * nudge on a real send slot. Idempotent: a second call for the same outreach
 * is a no-op. Returns the first follow-up's slot (ms), or null.
 */
export async function startSequence(
  admin: Admin,
  outreach: Pick<Outreach, "id" | "lead_id" | "contact_id" | "sent_at">,
  opts: { email?: string | null } = {},
): Promise<number | null> {
  const sentAt = outreach.sent_at ? new Date(outreach.sent_at) : new Date();
  const tz = await leadTz(admin, outreach.lead_id);
  const earliest = followupEarliest(sentAt, 1, tz);
  const { data } = await admin
    .from("followup_sequences")
    .upsert(
      {
        outreach_id: outreach.id,
        lead_id: outreach.lead_id,
        contact_id: outreach.contact_id,
        steps_sent: 0,
        max_steps: MAX_FOLLOWUPS,
        next_due_at: new Date(earliest).toISOString(),
        status: "active",
      },
      { onConflict: "outreach_id", ignoreDuplicates: true },
    )
    .select("id");
  const seqId = (data as Array<{ id: string }> | null)?.[0]?.id;
  if (!seqId) return null;
  try {
    const at = await planFollowupSlot(
      admin,
      { id: seqId, lead_id: outreach.lead_id },
      { earliest, email: opts.email },
    );
    await admin
      .from("followup_sequences")
      .update({ next_due_at: new Date(at).toISOString() })
      .eq("id", seqId);
    return at;
  } catch {
    // The day-level due date stands; the queue tick fits it to a slot.
    return earliest;
  }
}

/** Stop the sequence whose initial outreach started the given Gmail thread. */
export async function stopSequencesForOutreach(
  admin: Admin,
  outreachId: string,
  reason: string,
): Promise<void> {
  await admin
    .from("followup_sequences")
    .update({ status: "stopped", stop_reason: reason, next_due_at: null })
    .eq("outreach_id", outreachId)
    .in("status", ["active", "paused"]);
}

interface LoadedSequence extends FollowupSequence {
  outreach: Outreach | null;
  lead: Lead | null;
  contact: Contact | null;
}

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

async function loadSequences(
  admin: Admin,
  opts: { dueOnly: boolean; ids?: string[] },
): Promise<LoadedSequence[]> {
  let q = admin
    .from("followup_sequences")
    .select(
      "*, outreach:outreach!followup_sequences_outreach_id_fkey(*), lead:leads(*), contact:contacts(*)",
    )
    .order("next_due_at", { ascending: true });
  if (opts.ids?.length) q = q.in("id", opts.ids);
  else {
    q = q.eq("status", "active");
    if (opts.dueOnly) q = q.lte("next_due_at", new Date().toISOString());
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown[]).map((raw) => {
    const r = raw as FollowupSequence & {
      outreach: Outreach | Outreach[] | null;
      lead: Lead | Lead[] | null;
      contact: Contact | Contact[] | null;
    };
    return {
      ...r,
      outreach: one(r.outreach),
      lead: one(r.lead),
      contact: one(r.contact),
    };
  });
}

async function getRulesAndVoice(admin: Admin): Promise<{
  rules: TailoringRule[];
  voiceInjection: string | null;
}> {
  const [rulesRes, voiceRes] = await Promise.all([
    admin.from("tailoring_rules").select("*").eq("is_active", true),
    admin
      .from("voice_profile")
      .select("prompt_injection")
      .eq("is_active", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    rules: (rulesRes.data as TailoringRule[]) ?? [],
    voiceInjection:
      (voiceRes.data as { prompt_injection: string | null } | null)
        ?.prompt_injection ?? null,
  };
}

async function stop(
  admin: Admin,
  seq: LoadedSequence,
  reason: string,
  note?: string,
): Promise<void> {
  await admin
    .from("followup_sequences")
    .update({ status: "stopped", stop_reason: reason, next_due_at: null })
    .eq("id", seq.id);
  if (note) {
    await admin
      .from("interactions")
      .insert({ lead_id: seq.lead_id, kind: "note", detail: note });
  }
}

/**
 * Send the next follow-up for one sequence, after re-checking every guard.
 * Returns what happened so callers can summarize.
 */
async function processSequence(
  admin: Admin,
  seq: LoadedSequence,
  ctx: { rules: TailoringRule[]; voiceInjection: string | null; guardBatch: GuardBatch },
): Promise<"sent" | "stopped" | "skipped"> {
  const root = seq.outreach;
  const lead = seq.lead;
  if (!root || !lead) {
    await stop(admin, seq, "Original outreach or lead no longer exists.");
    return "stopped";
  }

  // Guard 1: the lead must still be sitting in the outreach stage.
  if (!FOLLOWUP_ELIGIBLE_STATUSES.includes(lead.status)) {
    await stop(
      admin,
      seq,
      `Lead status is ${statusLabel(lead.status)}; follow-ups stopped.`,
    );
    return "stopped";
  }

  // Guard 2: a reply/bounce already recorded by the inbox scan.
  if (root.replied_at) {
    await stop(admin, seq, "They replied.");
    return "stopped";
  }
  if (root.bounced_at) {
    await stop(admin, seq, "Original email bounced.");
    return "stopped";
  }

  // Guard 2b: referred contacts are handled by hand, never nudged.
  if (seq.contact?.referred_by_contact_id) {
    await stop(admin, seq, "Referred contact; handled by hand.");
    return "stopped";
  }

  // Guard 3: a usable recipient that hasn't bounced.
  const email = seq.contact?.email ?? null;
  if (!looksLikeRealEmail(email)) {
    await stop(admin, seq, "Contact has no valid email.");
    return "stopped";
  }
  if (seq.contact?.contact_status === "bounced" || seq.contact?.contact_status === "invalid") {
    await stop(admin, seq, "Email bounced.");
    return "stopped";
  }

  // Guard 3a: the contact is out for the holidays (contacts.ooo_until,
  // migration 0035). Nothing goes to them before that date, in their own
  // time zone: move the sequence to the first slot on it. Every other guard
  // runs again then, so a reply in the meantime still stops it.
  const tz = tzOfLead(lead);
  const today = dayKey(Date.now(), tz);
  if (contactIsOut(seq.contact, today)) {
    const at = await slotAfterHoliday(
      admin,
      { kind: "followup", id: seq.id, leadId: lead.id, email, tz },
      seq.contact?.ooo_until as string,
    );
    await admin
      .from("followup_sequences")
      .update({ next_due_at: new Date(at).toISOString() })
      .eq("id", seq.id)
      .eq("status", "active");
    return "skipped";
  }

  // Guard 3b: the ORGANIZATION must not be in a conversation anywhere: a
  // sibling lead, a colleague who replied to a different thread, or a thread
  // Jeff started by hand. Fails closed (error recorded, retried next run).
  try {
    const guard = await checkEngagementGuard(admin, lead.id, {
      contactEmail: email,
      batch: ctx.guardBatch,
    });
    if (guard.blocked) {
      const reason = summarizeConflicts(guard);
      await stop(
        admin,
        seq,
        "Organization is already in conversation.",
        `Follow-ups to everyone at this organization stopped. ${reason}`,
      );
      await stopFollowupsForOrganization(
        admin,
        lead.id,
        "Organization is already in conversation.",
      );
      return "stopped";
    }
  } catch (e) {
    if (e instanceof EngagementGuardUnavailableError) {
      await admin
        .from("followup_sequences")
        .update({ last_error: e.message })
        .eq("id", seq.id);
      throw new Error(`${lead.name}: ${e.message}`);
    }
    throw e;
  }

  // Guard 4: live thread check. Never follow up on a thread that already
  // has a human reply, even if the scan missed it (e.g. a mail rule archived
  // it out of the inbox). Out-of-office auto-replies don't count.
  if (!root.gmail_thread_id) {
    await stop(admin, seq, "No Gmail thread recorded for the original email.");
    return "stopped";
  }
  let thread;
  try {
    thread = await getThreadState(root.gmail_thread_id);
  } catch (e) {
    const msg =
      e instanceof GmailNotConnectedError
        ? e.message
        : e instanceof Error
          ? `Could not read the Gmail thread: ${e.message}`
          : "Could not read the Gmail thread.";
    await admin
      .from("followup_sequences")
      .update({ last_error: msg })
      .eq("id", seq.id);
    throw new Error(`${lead.name}: ${msg}`);
  }
  if (thread.hasReply) {
    await admin
      .from("outreach")
      .update({ replied_at: new Date().toISOString() })
      .eq("id", root.id)
      .is("replied_at", null);
    await stop(
      admin,
      seq,
      "They replied.",
      `A reply was found in the thread with ${email}; follow-ups to everyone at this organization stopped. Open the thread to set the lead's status.`,
    );
    await stopFollowupsForOrganization(admin, lead.id, "Someone at the organization replied.");
    return "stopped";
  }
  if (thread.hasBounce) {
    await admin
      .from("outreach")
      .update({ bounced_at: new Date().toISOString() })
      .eq("id", root.id)
      .is("bounced_at", null);
    await stop(admin, seq, "Email bounced.");
    // A delivery failure in our own thread: never email this address again.
    await markAddressBounced(admin, email as string, "delivery failure in the outreach thread");
    return "stopped";
  }

  const step = seq.steps_sent + 1;
  if (step > seq.max_steps) {
    await admin
      .from("followup_sequences")
      .update({ status: "completed", next_due_at: null })
      .eq("id", seq.id);
    return "skipped";
  }

  // Earlier follow-ups in this thread, so the model doesn't repeat itself.
  const { data: priorRows } = await admin
    .from("outreach")
    .select("body, sequence_step, sent_at")
    .eq("parent_outreach_id", root.id)
    .eq("status", "sent")
    .order("sequence_step", { ascending: true });
  const prior = (priorRows ?? []) as { body: string; sent_at: string | null }[];
  const priorFollowups = prior.map((r) => r.body);

  // First nudge after a holiday out-of-office: nothing has gone to this
  // contact since the OOO (our last email in the thread predates the day they
  // were due back), so open by acknowledging it.
  const lastSentAt = [root.sent_at, ...prior.map((r) => r.sent_at)]
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  const oooUntil = seq.contact?.ooo_until ?? null;
  const holidayOpener = Boolean(
    oooUntil &&
      (seq.contact?.ooo_reason ?? "").startsWith(HOLIDAY_REASON_PREFIX) &&
      lastSentAt &&
      dayKey(new Date(lastSentAt).getTime(), tz) < oooUntil,
  );

  const gen = await generateFollowup({
    lead,
    contact: seq.contact,
    step,
    original: { subject: root.subject, body: root.body, sentAt: root.sent_at },
    priorFollowups,
    rules: ctx.rules,
    voiceInjection: ctx.voiceInjection,
    holidayOpener,
  });

  const subject = /^re:/i.test(root.subject) ? root.subject : `Re: ${root.subject}`;
  // Thread properly in every client, not just Gmail: In-Reply-To the last
  // message we sent, References the whole chain.
  const inReplyTo = thread.lastOurRfcId ?? thread.references[thread.references.length - 1] ?? null;
  const result = await sendGmail({
    to: email as string,
    subject,
    body: gen.body,
    thread: {
      threadId: root.gmail_thread_id,
      inReplyTo,
      references: thread.references,
    },
  });
  const now = new Date();

  await admin.from("outreach").insert({
    lead_id: seq.lead_id,
    contact_id: seq.contact_id,
    subject,
    body: gen.body,
    status: "sent",
    gmail_message_id: result.messageId,
    gmail_thread_id: result.threadId || root.gmail_thread_id,
    sent_at: now.toISOString(),
    sequence_step: step,
    parent_outreach_id: root.id,
  });

  const done = step >= seq.max_steps;
  let nextAt: number | null = null;
  if (!done) {
    const earliest = followupEarliest(now, step + 1, tz);
    try {
      nextAt = await planFollowupSlot(admin, seq, { earliest, email });
    } catch {
      nextAt = earliest;
    }
  }
  await admin
    .from("followup_sequences")
    .update({
      steps_sent: step,
      status: done ? "completed" : "active",
      next_due_at: nextAt === null ? null : new Date(nextAt).toISOString(),
      last_error: null,
    })
    .eq("id", seq.id);

  await admin.from("interactions").insert({
    lead_id: seq.lead_id,
    kind: "followup_sent",
    detail: `Follow-up #${step} sent to ${email} (auto, in the original thread${
      holidayOpener ? ", post-holiday nudge" : ""
    }).`,
  });

  // Advance the lead status to followup_N, never backwards (a lead with two
  // contacts may already be at a later step from the other thread).
  const target: LeadStatus = followupStatusForStep(step);
  if (stepOfStatus(lead.status) < step) {
    await admin.from("leads").update({ status: target }).eq("id", seq.lead_id);
    await admin.from("interactions").insert({
      lead_id: seq.lead_id,
      kind: "status_change",
      detail: `Status set to ${statusLabel(target)} (auto: follow-up sent).`,
    });
  }
  return "sent";
}

export interface FollowupContext {
  rules: TailoringRule[];
  voiceInjection: string | null;
  guardBatch: GuardBatch;
}

export async function newFollowupContext(
  admin: Admin,
  guardBatch: GuardBatch = newGuardBatch(),
): Promise<FollowupContext> {
  return { ...(await getRulesAndVoice(admin)), guardBatch };
}

/**
 * Send the next follow-up for ONE sequence, after re-checking every guard.
 * Called by the send-queue tick (lib/outreach/send.ts) when the sequence's
 * slot comes up; pacing has already been checked there. Throws on a mailbox
 * or Gmail error so the tick can retry later.
 */
export async function sendFollowupForSequence(
  admin: Admin,
  sequenceId: string,
  ctx: FollowupContext,
): Promise<"sent" | "stopped" | "skipped"> {
  const [seq] = await loadSequences(admin, { dueOnly: false, ids: [sequenceId] });
  if (!seq || seq.status !== "active") return "skipped";
  return processSequence(admin, seq, ctx);
}

/**
 * The daily follow-up job: read new replies so organizations that answered
 * drop out before their next nudge. Sending itself happens one email at a
 * time on scheduled slots via the send-queue tick.
 */
export async function scanRepliesForFollowups(): Promise<RunSummary> {
  const admin = createAdminClient();
  return {
    checked: 0,
    sent: 0,
    stopped: 0,
    errors: [],
    replyScan: await scanInboxForReplies(admin),
  };
}
