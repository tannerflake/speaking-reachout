"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveRules, getActiveVoiceInjection, getLead } from "@/lib/data";
import { generateOutreach } from "@/lib/claude/outreach";
import { pickPrimaryContact, statusLabel } from "@/lib/utils";
import { createAdminClient } from "@/lib/supabase/admin";
import { stopSequencesForLead } from "@/lib/followups/stop";
import { FOLLOWUP_ELIGIBLE_STATUSES } from "@/lib/followups/cadence";
import type { BookingOutcome, InquiryType, LeadKind, LeadStatus } from "@/lib/types";
import { BOOKING_OUTCOMES } from "@/lib/types";
import {
  INQUIRY_BADGE,
  INQUIRY_REFUSAL,
  isInquiryLead,
  isInquiryType,
} from "@/lib/leads/kind";
import { getCurrentUser } from "@/lib/auth/profile";

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
 * Change a lead's status. Moving to Interested or Back burner can carry an optional
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
  /** Required when event_date is empty (migration 0037). */
  event_year?: number | null;
  event_end_date?: string | null;
  location?: string | null;
  /** null = let the DB trigger derive it from the date/year. */
  outcome?: BookingOutcome | null;
  /** Also set the lead's status to Booked (default true, the old behavior). */
  markBooked?: boolean;
}

function validateBooking(input: BookingInput): { error?: string; row?: Record<string, unknown> } {
  const name = input.event_name?.trim();
  if (!name) return { error: "Event name is required." };
  const date = input.event_date?.trim() || null;
  const end = input.event_end_date?.trim() || null;
  const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (date && !isDate(date)) return { error: "Use a date like 2027-03-15." };
  if (end && !isDate(end)) return { error: "Use an end date like 2027-03-16." };
  let year = input.event_year ?? null;
  if (year != null && (!Number.isInteger(year) || year < 1990 || year > 2100)) {
    return { error: "Year must be a year like 2025." };
  }
  if (date) year = Number(date.slice(0, 4));
  if (!date && year == null) return { error: "Give an event date, or at least the year." };
  if (input.outcome && !BOOKING_OUTCOMES.includes(input.outcome)) return { error: "Unknown outcome." };
  if (input.fee != null && (!Number.isFinite(input.fee) || input.fee < 0)) return { error: "Fee must be a positive number." };
  return {
    row: {
      event_name: name,
      event_date: date,
      event_end_date: end,
      event_year: year,
      topic: input.topic?.trim() || null,
      fee: input.fee,
      is_recurring: input.is_recurring,
      notes: input.notes?.trim() || null,
      location: input.location?.trim() || null,
      // null lets the trigger set upcoming/completed from the date or year.
      outcome: input.outcome ?? null,
    },
  };
}

function revalidateLead(leadId: string) {
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin");
}

/** Add an engagement (booking). By default also marks the lead Booked. */
export async function saveBooking(
  leadId: string,
  input: BookingInput,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const v = validateBooking(input);
  if (v.error || !v.row) return { error: v.error };

  const { data, error } = await supabase
    .from("bookings")
    .insert({ lead_id: leadId, ...v.row, source: "manual" })
    .select("outcome")
    .single();
  if (error) return { error: error.message };
  const outcome = (data as { outcome: BookingOutcome | null } | null)?.outcome ?? null;

  const when = (v.row.event_date as string | null) ?? String(v.row.event_year);
  if (input.markBooked !== false && outcome !== "canceled") {
    // Ensure the lead is marked booked (and end any automated follow-ups).
    await supabase.from("leads").update({ status: "booked" }).eq("id", leadId);
    await stopSequencesForLead(createAdminClient(), leadId, "Booked.");
    await logInteraction(leadId, "status_change", `Booked: ${v.row.event_name} (${when}).`);
  } else {
    await logInteraction(
      leadId,
      "note",
      `Engagement added: ${v.row.event_name} (${when}${outcome ? `, ${outcome}` : ""}).`,
    );
  }
  revalidateLead(leadId);
  return {};
}

/** Edit an engagement. */
export async function updateBooking(
  bookingId: string,
  input: BookingInput,
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const v = validateBooking(input);
  if (v.error || !v.row) return { error: v.error };
  const { data, error } = await supabase
    .from("bookings")
    .update(v.row)
    .eq("id", bookingId)
    .select("lead_id")
    .single();
  if (error) return { error: error.message };
  const leadId = (data as { lead_id: string }).lead_id;
  await logInteraction(leadId, "note", `Engagement updated: ${v.row.event_name}.`);
  revalidateLead(leadId);
  return {};
}

/** Delete an engagement. Lead status is left alone. */
export async function deleteBooking(bookingId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bookings")
    .delete()
    .eq("id", bookingId)
    .select("lead_id, event_name, event_year")
    .single();
  if (error) return { error: error.message };
  const row = data as { lead_id: string; event_name: string; event_year: number | null };
  await logInteraction(
    row.lead_id,
    "note",
    `Engagement deleted: ${row.event_name}${row.event_year ? ` (${row.event_year})` : ""}.`,
  );
  revalidateLead(row.lead_id);
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
  if (isInquiryLead(lead)) return { error: INQUIRY_REFUSAL };

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

/**
 * Reclassify a lead as a speaking prospect or a non-booking inquiry (Advanced
 * panel, behind a confirm step). Moving to 'inquiry' stops its follow-ups,
 * returns scheduled emails to draft and takes it off the enrichment queue, so
 * nothing automatic touches it again. Logged in the activity feed.
 */
export async function setLeadKind(
  leadId: string,
  kind: LeadKind,
  inquiryType: InquiryType | null,
): Promise<{ error?: string }> {
  if (kind !== "speaking" && kind !== "inquiry") return { error: "Unknown lead kind." };
  if (kind === "inquiry" && !isInquiryType(inquiryType)) {
    return { error: "Pick an inquiry type." };
  }
  const supabase = await createClient();
  const { data: before } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();
  if (!before) return { error: "Lead not found." };
  const prev = before as { kind?: LeadKind; inquiry_type?: InquiryType | null };
  if (prev.kind === undefined) {
    return {
      error:
        "Lead kinds need database migration 0036 to be applied first.",
    };
  }
  const nextType = kind === "inquiry" ? inquiryType : null;
  if (prev.kind === kind && (prev.inquiry_type ?? null) === nextType) return {};

  const { error } = await supabase
    .from("leads")
    .update({ kind, inquiry_type: nextType })
    .eq("id", leadId);
  if (error) return { error: error.message };

  if (kind === "inquiry") {
    const admin = createAdminClient();
    await stopSequencesForLead(admin, leadId, "Reclassified as a non-booking inquiry.");
    await admin
      .from("outreach")
      .update({ status: "draft", scheduled_for: null })
      .eq("lead_id", leadId)
      .eq("status", "queued");
    // Off the contact-finding queue (errors harmlessly before migration 0030).
    await admin
      .from("leads")
      .update({ enrich_status: null })
      .eq("id", leadId)
      .in("enrich_status", ["pending"]);
  }

  const describe = (k: LeadKind | undefined, t: InquiryType | null | undefined) =>
    k === "inquiry" ? (isInquiryType(t) ? INQUIRY_BADGE[t] : "Inquiry") : "Speaking lead";
  const me = await getCurrentUser();
  await logInteraction(
    leadId,
    "status_change",
    `Lead kind changed from ${describe(prev.kind, prev.inquiry_type)} to ${describe(kind, nextType)} by ${me?.email ?? "unknown user"}.${
      kind === "inquiry" ? " Outreach, contact finding and follow-ups are off for this lead." : ""
    }`,
  );
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin/inquiries");
  revalidatePath("/admin");
  return {};
}
