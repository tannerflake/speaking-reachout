"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { planFollowupSlot } from "@/lib/followups/run";
import { runSendTick, type TickResult } from "@/lib/outreach/send";
import { scanInboxForReplies } from "@/lib/gmail/replyScan";

function revalidateLead(leadId: string | null) {
  if (leadId) revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin");
}

/**
 * Operator button: read new replies, then run one send-queue tick. Follow-ups
 * go out one at a time on their scheduled slots, so this sends at most one
 * email, and only if the pacing rules allow it right now.
 */
export async function sendDueFollowups(): Promise<TickResult & { error?: string; replyError?: string }> {
  try {
    const admin = createAdminClient();
    const scan = await scanInboxForReplies(admin);
    const res = await runSendTick(admin);
    revalidateLead(null);
    return { ...res, replyError: scan.error };
  } catch (e) {
    return {
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
      error: e instanceof Error ? e.message : "Queue run failed.",
    };
  }
}

/**
 * Operator button on a lead: move this sequence's next follow-up to the
 * earliest open slot (still paced and inside the recipient's business hours).
 */
export async function sendFollowupNow(
  sequenceId: string,
): Promise<{ error?: string; sent?: boolean; note?: string }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("followup_sequences")
    .select("id, lead_id, status, contact:contacts(email)")
    .eq("id", sequenceId)
    .maybeSingle();
  const row = data as {
    id: string;
    lead_id: string;
    status: string;
    contact: { email: string | null } | { email: string | null }[] | null;
  } | null;
  if (!row) return { error: "Sequence not found." };
  if (row.status !== "active") {
    return { error: `Sequence is ${row.status}; resume it first.` };
  }
  const contact = Array.isArray(row.contact) ? row.contact[0] : row.contact;
  const at = await planFollowupSlot(createAdminClient(), row, {
    earliest: Date.now() + 60_000,
    email: contact?.email ?? null,
  });
  await supabase
    .from("followup_sequences")
    .update({ next_due_at: new Date(at).toISOString(), last_error: null })
    .eq("id", sequenceId);
  revalidateLead(row.lead_id);
  return { note: `Next follow-up moved up to ${new Date(at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })} ET, the earliest paced slot.` };
}

export async function pauseSequence(
  sequenceId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("followup_sequences")
    .update({ status: "paused" })
    .eq("id", sequenceId)
    .eq("status", "active")
    .select("lead_id")
    .maybeSingle();
  if (error) return { error: error.message };
  const leadId = (data as { lead_id: string } | null)?.lead_id ?? null;
  if (leadId) {
    await supabase
      .from("interactions")
      .insert({ lead_id: leadId, kind: "note", detail: "Follow-ups paused." });
  }
  revalidateLead(leadId);
  return {};
}

export async function resumeSequence(
  sequenceId: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("followup_sequences")
    .select("lead_id, status, next_due_at, steps_sent")
    .eq("id", sequenceId)
    .maybeSingle();
  const row = existing as {
    lead_id: string;
    status: string;
    next_due_at: string | null;
    steps_sent: number;
  } | null;
  if (!row) return { error: "Sequence not found." };
  if (row.status !== "paused" && row.status !== "stopped") {
    return { error: `Sequence is ${row.status}.` };
  }
  // If the due date passed while paused, give it a fresh slot from tomorrow
  // rather than firing the moment it's resumed.
  const due =
    row.next_due_at && new Date(row.next_due_at) > new Date()
      ? row.next_due_at
      : new Date(
          await planFollowupSlot(createAdminClient(), { id: sequenceId, lead_id: row.lead_id }, {
            earliest: Date.now() + 20 * 3600 * 1000,
          }),
        ).toISOString();
  const { error } = await supabase
    .from("followup_sequences")
    .update({ status: "active", stop_reason: null, next_due_at: due })
    .eq("id", sequenceId);
  if (error) return { error: error.message };
  await supabase
    .from("interactions")
    .insert({ lead_id: row.lead_id, kind: "note", detail: "Follow-ups resumed." });
  revalidateLead(row.lead_id);
  return {};
}
