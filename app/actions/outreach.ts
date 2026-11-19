"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveRules, getActiveVoiceInjection, getLead } from "@/lib/data";
import { generateOutreach } from "@/lib/claude/outreach";
import { draftAllForLead, draftingBlocked } from "@/lib/outreach/draft";
import {
  getQueueStatus,
  queueOutreach,
  runSendTick,
  type QueueResult,
  type QueueStatus,
  type TickResult,
} from "@/lib/outreach/send";
import {
  checkEngagementGuard,
  type EngagementGuardResult,
} from "@/lib/outreach/guard";
import { pickPrimaryContact } from "@/lib/utils";
import type { Contact, Outreach } from "@/lib/types";

export interface DraftResult {
  id?: string;
  error?: string;
  styleAdjusted?: boolean;
}

export async function generateDraft(
  leadId: string,
  contactId?: string | null,
  oneOff?: string,
  opts?: { acknowledgeConflict?: boolean },
): Promise<DraftResult> {
  const lead = await getLead(leadId);
  if (!lead) return { error: "Lead not found." };
  const blockedReason = await draftingBlocked(
    await createClient(),
    leadId,
    opts?.acknowledgeConflict,
  );
  if (blockedReason) return { error: blockedReason };
  const [rules, voiceInjection] = await Promise.all([
    getActiveRules(),
    getActiveVoiceInjection(),
  ]);

  const contact: Contact | null = contactId
    ? (lead.contacts.find((c) => c.id === contactId) ??
      pickPrimaryContact(lead.contacts))
    : pickPrimaryContact(lead.contacts);

  try {
    const gen = await generateOutreach({
      lead,
      contact,
      rules,
      oneOffInstruction: oneOff,
      voiceInjection,
    });
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("outreach")
      .insert({
        lead_id: leadId,
        contact_id: contact?.id ?? null,
        subject: gen.subject,
        body: gen.body,
        status: "draft",
      })
      .select("id")
      .single();
    if (error) return { error: error.message };
    revalidatePath(`/admin/leads/${leadId}`);
    return { id: (data as { id: string }).id, styleAdjusted: gen.styleAdjusted };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to draft outreach." };
  }
}

export async function updateDraft(
  outreachId: string,
  subject: string,
  body: string,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("outreach")
    .select("lead_id, status")
    .eq("id", outreachId)
    .single();
  if (!existing) return { error: "Draft not found." };
  if ((existing as { status: string }).status === "sent") {
    return { error: "This outreach was already sent and can't be edited." };
  }

  const { error } = await supabase
    .from("outreach")
    .update({ subject: subject.trim(), body: body.trim() })
    .eq("id", outreachId);
  if (error) return { error: error.message };

  revalidatePath(`/admin/leads/${(existing as { lead_id: string }).lead_id}`);
  return {};
}

export async function regenerateDraft(
  outreachId: string,
  oneOff?: string,
): Promise<DraftResult> {
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("outreach")
    .select("lead_id, contact_id, status")
    .eq("id", outreachId)
    .single();
  if (!existing) return { error: "Draft not found." };
  const row = existing as { lead_id: string; contact_id: string | null; status: string };
  if (row.status === "sent") {
    return { error: "This outreach was already sent." };
  }

  const lead = await getLead(row.lead_id);
  if (!lead) return { error: "Lead not found." };
  const [rules, voiceInjection] = await Promise.all([
    getActiveRules(),
    getActiveVoiceInjection(),
  ]);
  const contact =
    lead.contacts.find((c) => c.id === row.contact_id) ??
    pickPrimaryContact(lead.contacts);

  try {
    const gen = await generateOutreach({
      lead,
      contact,
      rules,
      oneOffInstruction: oneOff,
      voiceInjection,
    });
    const { error } = await supabase
      .from("outreach")
      .update({
        subject: gen.subject,
        body: gen.body,
        status: "draft",
        error: null,
      })
      .eq("id", outreachId);
    if (error) return { error: error.message };
    revalidatePath(`/admin/leads/${row.lead_id}`);
    return { id: outreachId, styleAdjusted: gen.styleAdjusted };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to regenerate." };
  }
}

/**
 * Approve drafts for sending: they go into the send queue with scheduled
 * times (weekday business hours in the recipient's zone, paced, colleagues
 * spread out). Nothing leaves immediately. Unverified addresses are held.
 */
export async function approveAndSchedule(
  outreachIds: string[],
): Promise<QueueResult> {
  const supabase = await createClient();
  const res = await queueOutreach(supabase, { outreachIds });
  const { data } = await supabase.from("outreach").select("lead_id").in("id", outreachIds);
  for (const leadId of new Set(((data ?? []) as Array<{ lead_id: string }>).map((r) => r.lead_id))) {
    revalidatePath(`/admin/leads/${leadId}`);
  }
  revalidatePath("/admin/leads");
  revalidatePath("/admin");
  return res;
}

/** Take one queued email back out of the queue (back to draft). */
export async function unscheduleOutreach(outreachId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("outreach")
    .update({ status: "draft", scheduled_for: null })
    .eq("id", outreachId)
    .eq("status", "queued")
    .select("lead_id");
  if (error) return { error: error.message };
  const leadId = (data as Array<{ lead_id: string }> | null)?.[0]?.lead_id;
  if (leadId) revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  return {};
}

/** The engagement guard's verdict for a lead, for the lead page banner. */
export async function engagementStatus(
  leadId: string,
): Promise<EngagementGuardResult | { error: string }> {
  const supabase = await createClient();
  try {
    return await checkEngagementGuard(supabase, leadId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Check failed." };
  }
}

/**
 * Operator override: send one draft even though the organization is already
 * in a conversation. Requires a reason, which is stored on the row and
 * written to the activity log. The only way a blocked email ever goes out.
 */
export async function overrideAndSend(
  outreachId: string,
  reason: string,
): Promise<{ error?: string; ok?: boolean }> {
  const trimmed = reason.trim();
  if (trimmed.length < 8) {
    return { error: "Give a reason for sending despite the existing conversation (at least a few words)." };
  }
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("outreach")
    .select("id, lead_id, status")
    .eq("id", outreachId)
    .single();
  if (!existing) return { error: "Draft not found." };
  const row = existing as { lead_id: string; status: string };
  if (row.status === "sent") return { error: "Already sent." };

  const { error } = await supabase
    .from("outreach")
    .update({
      status: "draft",
      error: null,
      guard_override_reason: trimmed,
      guard_override_at: new Date().toISOString(),
    })
    .eq("id", outreachId);
  if (error) {
    return {
      error: `Could not record the override (${error.message}). Has migration 0024 been applied?`,
    };
  }
  await supabase.from("interactions").insert({
    lead_id: row.lead_id,
    kind: "note",
    detail: `Engagement guard overridden by the operator for one draft: ${trimmed}`,
  });
  // Even an override goes out on a paced slot, never instantly.
  const res = await approveAndSchedule([outreachId]);
  if (res.error) return { error: res.error };
  if (res.queued === 0) {
    return {
      error:
        res.needsVerification > 0
          ? "Not queued: this address needs verification first."
          : "Not queued: check the draft's error message.",
    };
  }
  return { ok: true };
}

/**
 * Bulk send from the Leads page. Queues every unsent draft with a verified
 * contact email on the selected leads, each on its own scheduled slot (see
 * lib/outreach/schedule.ts), then returns immediately. The minute tick
 * (/api/cron/send-queue) sends them one at a time. EXPLICIT,
 * operator-confirmed.
 */
export async function queueSendForLeads(leadIds: string[]): Promise<QueueResult> {
  const supabase = await createClient();
  const res = await queueOutreach(supabase, { leadIds });
  revalidatePath("/admin/leads");
  return res;
}

/**
 * Run one queue tick (the Leads page calls this while open, as a fallback for
 * the minute cron). Sends at most one email, and only if the pacing allows.
 */
export async function drainSendQueue(): Promise<TickResult> {
  const supabase = await createClient();
  const res = await runSendTick(supabase);
  if (res.sent || res.failed || res.blocked || res.followupsSent) {
    revalidatePath("/admin/leads");
    revalidatePath("/admin");
  }
  return res;
}

export async function sendQueueStatus(): Promise<QueueStatus> {
  const supabase = await createClient();
  return getQueueStatus(supabase);
}

/** Pull every queued email back to draft so nothing more goes out. */
export async function cancelSendQueue(): Promise<{ cancelled: number }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("outreach")
    .update({ status: "draft", scheduled_for: null })
    .eq("status", "queued")
    .select("id");
  revalidatePath("/admin/leads");
  return { cancelled: (data as Array<{ id: string }> | null)?.length ?? 0 };
}

export async function bulkDraft(
  leadIds: string[],
): Promise<{ created: number; failed: number }> {
  let created = 0;
  let failed = 0;
  // Low concurrency — each draft does a web-search generation.
  const queue = [...leadIds];
  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      const res = await generateDraft(id);
      if (res.error) failed += 1;
      else created += 1;
    }
  }
  await Promise.all([worker(), worker()]);
  revalidatePath("/admin/leads");
  return { created, failed };
}

/**
 * Draft outreach for every contact on a lead that has an email and hasn't been
 * emailed or drafted yet (see lib/outreach/draft.ts).
 */
export async function draftForAllContacts(
  leadId: string,
  oneOff?: string,
  opts?: { acknowledgeConflict?: boolean },
): Promise<{ created: number; error?: string; styleAdjusted?: boolean }> {
  const supabase = await createClient();
  const res = await draftAllForLead(supabase, leadId, oneOff, opts);
  if (res.created > 0) revalidatePath(`/admin/leads/${leadId}`);
  return res;
}

/**
 * Schedule every unsent draft on a lead (one Gmail message per recipient,
 * never CC'd together, colleagues spread at least 45 minutes apart).
 * EXPLICIT, operator-confirmed.
 */
export async function sendAllDrafts(leadId: string): Promise<QueueResult> {
  const supabase = await createClient();
  const res = await queueOutreach(supabase, { leadIds: [leadId] });
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  return res;
}
