"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveRules, getActiveVoiceInjection, getLead } from "@/lib/data";
import { generateOutreach } from "@/lib/claude/outreach";
import { GmailNotConnectedError, sendGmail } from "@/lib/gmail/send";
import { looksLikeRealEmail, pickPrimaryContact } from "@/lib/utils";
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
): Promise<DraftResult> {
  const lead = await getLead(leadId);
  if (!lead) return { error: "Lead not found." };
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

export async function approveAndSend(
  outreachId: string,
): Promise<{ error?: string; ok?: boolean }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("outreach")
    .select("*, contact:contacts(*)")
    .eq("id", outreachId)
    .single();
  if (!data) return { error: "Draft not found." };

  const row = data as Outreach & { contact: Contact | null };
  if (row.status === "sent") return { error: "Already sent." };

  const email = row.contact?.email ?? null;
  if (!looksLikeRealEmail(email)) {
    return {
      error:
        "No valid contact email on this outreach. Resolve the contact's email before sending.",
    };
  }

  try {
    const result = await sendGmail({
      to: email as string,
      subject: row.subject,
      body: row.body,
    });

    await supabase
      .from("outreach")
      .update({
        status: "sent",
        gmail_message_id: result.messageId,
        gmail_thread_id: result.threadId,
        sent_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", outreachId);

    // Advance the lead to reached_out (auto-advance per Flow B). Only promote
    // from 'new' so we never downgrade a later-stage (e.g. booked) lead.
    await supabase
      .from("leads")
      .update({ status: "reached_out" })
      .eq("id", row.lead_id)
      .eq("status", "new");

    await supabase.from("interactions").insert({
      lead_id: row.lead_id,
      kind: "email_sent",
      detail: `Sent "${row.subject}" to ${email}.`,
    });

    revalidatePath(`/admin/leads/${row.lead_id}`);
    revalidatePath("/admin/leads");
    revalidatePath("/admin/admin");
    return { ok: true };
  } catch (e) {
    const message =
      e instanceof GmailNotConnectedError
        ? e.message
        : e instanceof Error
          ? e.message
          : "Send failed.";
    await supabase
      .from("outreach")
      .update({ status: "failed", error: message })
      .eq("id", outreachId);
    revalidatePath(`/admin/leads/${row.lead_id}`);
    return { error: message };
  }
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
