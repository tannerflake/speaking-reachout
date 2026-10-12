import { createAdminClient } from "@/lib/supabase/admin";
import { generateFollowup } from "@/lib/claude/followup";
import { GmailNotConnectedError, sendGmail } from "@/lib/gmail/send";
import { getThreadState } from "@/lib/gmail/thread";
import {
  EngagementGuardUnavailableError,
  checkEngagementGuard,
  summarizeConflicts,
} from "@/lib/outreach/guard";
import { looksLikeRealEmail, statusLabel } from "@/lib/utils";
import {
  FOLLOWUP_ELIGIBLE_STATUSES,
  MAX_FOLLOWUPS,
  computeDueAt,
  followupStatusForStep,
  stepOfStatus,
} from "@/lib/followups/cadence";
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
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Start a follow-up sequence for a just-sent initial outreach. Idempotent:
 * a second call for the same outreach is a no-op.
 */
export async function startSequence(
  admin: Admin,
  outreach: Pick<Outreach, "id" | "lead_id" | "contact_id" | "sent_at">,
): Promise<void> {
  const sentAt = outreach.sent_at ? new Date(outreach.sent_at) : new Date();
  await admin.from("followup_sequences").upsert(
    {
      outreach_id: outreach.id,
      lead_id: outreach.lead_id,
      contact_id: outreach.contact_id,
      steps_sent: 0,
      max_steps: MAX_FOLLOWUPS,
      next_due_at: computeDueAt(sentAt, 1).toISOString(),
      status: "active",
    },
    { onConflict: "outreach_id", ignoreDuplicates: true },
  );
}

/** Stop every active/paused sequence on a lead (e.g. status moved on). */
export async function stopSequencesForLead(
  admin: Admin,
  leadId: string,
  reason: string,
): Promise<void> {
  await admin
    .from("followup_sequences")
    .update({ status: "stopped", stop_reason: reason, next_due_at: null })
    .eq("lead_id", leadId)
    .in("status", ["active", "paused"]);
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
  ctx: { rules: TailoringRule[]; voiceInjection: string | null },
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

  // Guard 3: a usable recipient.
  const email = seq.contact?.email ?? null;
  if (!looksLikeRealEmail(email)) {
    await stop(admin, seq, "Contact has no valid email.");
    return "stopped";
  }

  // Guard 3b: the ORGANIZATION must not be in a conversation anywhere: a
  // sibling lead, a colleague who replied to a different thread, or a thread
  // Jeff started by hand. Fails closed (error recorded, retried next run).
  try {
    const guard = await checkEngagementGuard(admin, lead.id, { contactEmail: email });
    if (guard.blocked) {
      const reason = summarizeConflicts(guard);
      await stop(
        admin,
        seq,
        "Organization is already in conversation.",
        `Follow-ups to ${email} stopped. ${reason}`,
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
  // has a human reply, even if the scan hasn't run yet.
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
      `A reply was found in the thread with ${email}; follow-ups stopped. Run "Scan email" to classify it.`,
    );
    return "stopped";
  }
  if (thread.hasBounce) {
    await admin
      .from("outreach")
      .update({ bounced_at: new Date().toISOString() })
      .eq("id", root.id)
      .is("bounced_at", null);
    await stop(
      admin,
      seq,
      "Email bounced.",
      `Delivery to ${email} bounced; follow-ups stopped. Consider re-looking up the address.`,
    );
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
    .select("body, sequence_step")
    .eq("parent_outreach_id", root.id)
    .eq("status", "sent")
    .order("sequence_step", { ascending: true });
  const priorFollowups = ((priorRows ?? []) as { body: string }[]).map(
    (r) => r.body,
  );

  const gen = await generateFollowup({
    lead,
    contact: seq.contact,
    step,
    original: { subject: root.subject, body: root.body, sentAt: root.sent_at },
    priorFollowups,
    rules: ctx.rules,
    voiceInjection: ctx.voiceInjection,
  });

  const subject = /^re:/i.test(root.subject) ? root.subject : `Re: ${root.subject}`;
  const result = await sendGmail({
    to: email as string,
    subject,
    body: gen.body,
    thread: {
      threadId: root.gmail_thread_id,
      inReplyTo: thread.lastOurRfcId,
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
  await admin
    .from("followup_sequences")
    .update({
      steps_sent: step,
      status: done ? "completed" : "active",
      next_due_at: done ? null : computeDueAt(now, step + 1).toISOString(),
      last_error: null,
    })
    .eq("id", seq.id);

  await admin.from("interactions").insert({
    lead_id: seq.lead_id,
    kind: "followup_sent",
    detail: `Follow-up #${step} sent to ${email} (auto, in the original thread).`,
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

/**
 * Send every follow-up that is due. Called by the daily scheduler and by the
 * operator's "Send due follow-ups" button. Each sequence is processed
 * sequentially (Gmail + one short model call each) and failures are isolated.
 */
export async function runDueFollowups(opts?: {
  /** Process these sequence ids regardless of due date (operator "send now"). */
  sequenceIds?: string[];
  limit?: number;
}): Promise<RunSummary> {
  const admin = createAdminClient();
  const summary: RunSummary = { checked: 0, sent: 0, stopped: 0, errors: [] };

  const sequences = await loadSequences(admin, {
    dueOnly: !opts?.sequenceIds,
    ids: opts?.sequenceIds,
  });
  const batch = sequences.slice(0, opts?.limit ?? 40);
  if (batch.length === 0) return summary;

  const ctx = await getRulesAndVoice(admin);

  for (const seq of batch) {
    summary.checked += 1;
    try {
      const outcome = await processSequence(admin, seq, ctx);
      if (outcome === "sent") summary.sent += 1;
      else if (outcome === "stopped") summary.stopped += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Follow-up failed.";
      summary.errors.push(msg);
      await admin
        .from("followup_sequences")
        .update({ last_error: msg })
        .eq("id", seq.id);
    }
  }
  return summary;
}
