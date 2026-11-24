"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveRules, getActiveVoiceInjection, getLead } from "@/lib/data";
import { generateOutreach } from "@/lib/claude/outreach";
import { pickPrimaryContact, statusLabel } from "@/lib/utils";
import { createAdminClient } from "@/lib/supabase/admin";
import { stopSequencesForLead } from "@/lib/followups/stop";
import { FOLLOWUP_ELIGIBLE_STATUSES } from "@/lib/followups/cadence";
import type { LeadStatus } from "@/lib/types";

async function logInteraction(
  leadId: string,
  kind: "status_change" | "note" | "email_sent" | "followup_sent" | "discovered",
  detail: string,
) {
  const supabase = await createClient();
  await supabase.from("interactions").insert({ lead_id: leadId, kind, detail });
}

/**
 * Write revisit_on / revisit_note. revisit_note arrives with migration 0034;
 * before it is applied a date-only change still saves (a note can't).
 */
async function writeRevisit(
  leadId: string,
  patch: Record<string, unknown> & { revisit_on: string | null; revisit_note: string | null },
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.from("leads").update(patch).eq("id", leadId);
  if (!error) return {};
  if (/revisit_note/.test(error.message)) {
    if (patch.revisit_note) {
      return {
        error:
          "Revisit notes need database migration 0034 to be applied. Save without a note, or apply the migration.",
      };
    }
    const { revisit_note: _omit, ...rest } = patch;
    void _omit;
    const retry = await supabase.from("leads").update(rest).eq("id", leadId);
    return retry.error ? { error: retry.error.message } : {};
  }
  return { error: error.message };
}

function validRevisitDate(value: string | null | undefined): string | null | false {
  const v = value?.trim() || null;
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return v;
}

/**
 * Change a lead's status. Moving to Back burner can carry an optional
 * revisit date and note in the same step (both may be left blank).
 */
export async function updateLeadStatus(
  leadId: string,
  status: LeadStatus,
  revisit?: { on: string | null; note: string | null },
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const revisitOn = revisit ? validRevisitDate(revisit.on) : null;
  if (revisitOn === false) return { error: "Use a date like 2027-03-15." };
  const revisitNote = revisit?.note?.trim() || null;

  const { error } = await supabase
    .from("leads")
    .update({ status })
    .eq("id", leadId);
  if (error) return { error: error.message };

  await logInteraction(leadId, "status_change", `Status set to ${statusLabel(status)}.`);

  let revisitError: string | undefined;
  if (revisit && (revisitOn || revisitNote)) {
    const res = await writeRevisit(leadId, { revisit_on: revisitOn, revisit_note: revisitNote });
    revisitError = res.error;
    if (!res.error) {
      await logInteraction(
        leadId,
        "note",
        revisitOn
          ? `Revisit date set to ${revisitOn}${revisitNote ? `: ${revisitNote}` : "."}`
          : `Revisit note set: ${revisitNote}`,
      );
    }
  }

  // Moving a lead past (or back before) the outreach stage ends any automated
  // follow-ups: a human has taken over.
  if (!FOLLOWUP_ELIGIBLE_STATUSES.includes(status)) {
    await stopSequencesForLead(
      createAdminClient(),
      leadId,
      `Status set to ${statusLabel(status)}.`,
    );
  }
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin");
  return revisitError ? { error: `Status saved, but the revisit date was not: ${revisitError}` } : {};
}

/**
 * Set or clear a lead's revisit date (YYYY-MM-DD, or null) and note. Any
 * status. Only surfaces the lead on the dashboard and in the leads list;
 * nothing is ever sent when the date arrives. Logged in the activity feed.
 */
export async function updateRevisit(
  leadId: string,
  revisitOn: string | null,
  note: string | null,
): Promise<{ error?: string }> {
  const value = validRevisitDate(revisitOn);
  if (value === false) return { error: "Use a date like 2027-03-15." };
  const trimmedNote = note?.trim() || null;
  if (trimmedNote && !value) {
    return { error: "Pick a revisit date to go with the note." };
  }
  const res = await writeRevisit(leadId, { revisit_on: value, revisit_note: trimmedNote });
  if (res.error) return res;

  await logInteraction(
    leadId,
    "note",
    value
      ? `Revisit date set to ${value}${trimmedNote ? `: ${trimmedNote}` : "."}`
      : "Revisit date cleared.",
  );
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin");
  return {};
}

/**
 * Permanently delete leads (and, via ON DELETE CASCADE, their contacts,
 * outreach, bookings, and interactions). Used to clear out junk/test data.
 * inbound_leads.crm_lead_id is set null by its FK rather than cascaded.
 */
export async function bulkDeleteLeads(
  leadIds: string[],
): Promise<{ deleted: number; error?: string }> {
  if (leadIds.length === 0) return { deleted: 0 };
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("leads")
    .delete({ count: "exact" })
    .in("id", leadIds);
  if (error) return { deleted: 0, error: error.message };

  revalidatePath("/admin/leads");
  revalidatePath("/admin/admin");
  return { deleted: count ?? leadIds.length };
}

export async function addNote(leadId: string, note: string): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) return;
  await logInteraction(leadId, "note", trimmed);
  revalidatePath(`/admin/leads/${leadId}`);
}

export interface BookingInput {
  event_name: string;
  event_date: string | null;
  topic: string | null;
  fee: number | null;
  is_recurring: boolean;
  notes: string | null;
}

export async function saveBooking(
  leadId: string,
  input: BookingInput,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  if (!input.event_name.trim()) return { error: "Event name is required." };

  const { error } = await supabase.from("bookings").insert({
    lead_id: leadId,
    event_name: input.event_name.trim(),
    event_date: input.event_date || null,
    topic: input.topic || null,
    fee: input.fee,
    is_recurring: input.is_recurring,
    notes: input.notes || null,
  });
  if (error) return { error: error.message };

  // Ensure the lead is marked booked (and end any automated follow-ups).
  await supabase.from("leads").update({ status: "booked" }).eq("id", leadId);
  await stopSequencesForLead(createAdminClient(), leadId, "Booked.");
  await logInteraction(
    leadId,
    "status_change",
    `Booked: ${input.event_name.trim()}${input.event_date ? ` (${input.event_date})` : ""}.`,
  );

  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin/admin");
  return {};
}

/**
 * Recurring booked events: start a fresh outreach cycle. Generates a new draft
 * for the lead while preserving all prior outreach history.
 */
export async function reachOutAgain(
  leadId: string,
): Promise<{ outreachId?: string; error?: string }> {
  const lead = await getLead(leadId);
  if (!lead) return { error: "Lead not found." };

  const [rules, voiceInjection] = await Promise.all([
    getActiveRules(),
    getActiveVoiceInjection(),
  ]);
  const contact = pickPrimaryContact(lead.contacts);

  try {
    const generated = await generateOutreach({
      lead,
      contact,
      rules,
      voiceInjection,
      oneOffInstruction:
        "This is a returning/recurring venue we have worked with before. Warmly reference that we'd love to come back, and propose fresh topics for the next cycle.",
    });

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("outreach")
      .insert({
        lead_id: leadId,
        contact_id: contact?.id ?? null,
        subject: generated.subject,
        body: generated.body,
        status: "draft",
        // Re-engaging a venue we've worked with is the one deliberate case
        // where "already in conversation" is the point, so the engagement
        // guard is overridden up front and the override is logged.
        guard_override_reason: "Reach out again: recurring venue",
        guard_override_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error) return { error: error.message };

    await logInteraction(
      leadId,
      "note",
      "Started a new outreach cycle (recurring venue). Engagement guard overridden for this draft: recurring venue.",
    );
    revalidatePath(`/admin/leads/${leadId}`);
    return { outreachId: (data as { id: string }).id };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : "Failed to draft outreach.",
    };
  }
}
