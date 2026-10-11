"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { runDueFollowups, type RunSummary } from "@/lib/followups/run";
import { weekdayAfter } from "@/lib/followups/cadence";

function revalidateLead(leadId: string | null) {
  if (leadId) revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin");
}

/** Operator button: send everything that's due right now. */
export async function sendDueFollowups(): Promise<RunSummary & { error?: string }> {
  try {
    const summary = await runDueFollowups();
    revalidateLead(null);
    return summary;
  } catch (e) {
    return {
      checked: 0,
      sent: 0,
      stopped: 0,
      errors: [],
      error: e instanceof Error ? e.message : "Follow-up run failed.",
    };
  }
}

/** Operator button on a lead: send this sequence's next follow-up today. */
export async function sendFollowupNow(
  sequenceId: string,
): Promise<{ error?: string; sent?: boolean; note?: string }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("followup_sequences")
    .select("lead_id, status")
    .eq("id", sequenceId)
    .maybeSingle();
  const row = data as { lead_id: string; status: string } | null;
  if (!row) return { error: "Sequence not found." };
  if (row.status !== "active") {
    return { error: `Sequence is ${row.status}; resume it first.` };
  }
  const summary = await runDueFollowups({ sequenceIds: [sequenceId] });
  revalidateLead(row.lead_id);
  if (summary.errors.length) return { error: summary.errors.join("; ") };
  if (summary.sent) return { sent: true };
  return { note: "Nothing sent: the sequence was stopped (reply, bounce, or status change)." };
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
  // If the due date passed while paused, push it to the next weekday rather
  // than firing the moment it's resumed.
  const due =
    row.next_due_at && new Date(row.next_due_at) > new Date()
      ? row.next_due_at
      : weekdayAfter(new Date(), 1).toISOString();
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
