"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveRules, getActiveVoiceInjection, getLead } from "@/lib/data";
import { generateOutreach } from "@/lib/claude/outreach";
import { pickPrimaryContact, statusLabel } from "@/lib/utils";
import type { LeadStatus } from "@/lib/types";

async function logInteraction(
  leadId: string,
  kind: "status_change" | "note" | "email_sent" | "discovered",
  detail: string,
) {
  const supabase = await createClient();
  await supabase.from("interactions").insert({ lead_id: leadId, kind, detail });
}

export async function updateLeadStatus(
  leadId: string,
  status: LeadStatus,
): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("leads")
    .update({ status })
    .eq("id", leadId);
  if (error) throw new Error(error.message);

  await logInteraction(leadId, "status_change", `Status set to ${statusLabel(status)}.`);
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin/admin");
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

  // Ensure the lead is marked booked.
  await supabase.from("leads").update({ status: "booked" }).eq("id", leadId);
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
      })
      .select("id")
      .single();
    if (error) return { error: error.message };

    await logInteraction(
      leadId,
      "note",
      "Started a new outreach cycle (recurring venue).",
    );
    revalidatePath(`/admin/leads/${leadId}`);
    return { outreachId: (data as { id: string }).id };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : "Failed to draft outreach.",
    };
  }
}
