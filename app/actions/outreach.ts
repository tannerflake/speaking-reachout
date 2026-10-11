"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveRules, getActiveVoiceInjection, getLead } from "@/lib/data";
import { generateOutreach } from "@/lib/claude/outreach";
import {
  getQueueStatus,
  queueOutreachForLeads,
  sendDueQueued,
  sendOutreachRow,
  type DrainResult,
  type QueueResult,
  type QueueStatus,
} from "@/lib/outreach/send";
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
  const res = await sendOutreachRow(supabase, outreachId);
  if (res.leadId) revalidatePath(`/admin/leads/${res.leadId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin");
  return res.ok ? { ok: true } : { error: res.error };
}

/**
 * Bulk send, throttled. Queues every unsent draft with a valid email on the
 * selected leads, spread over `spreadMinutes` (about one a minute by
 * default), then returns immediately. The Leads page drains the queue while
 * it is open and /api/cron/send-queue picks up the rest. EXPLICIT,
 * operator-confirmed.
 */
export async function queueSendForLeads(
  leadIds: string[],
  spreadMinutes: number,
): Promise<QueueResult> {
  const supabase = await createClient();
  const res = await queueOutreachForLeads(supabase, leadIds, spreadMinutes);
  revalidatePath("/admin/leads");
  return res;
}

/** Send whatever is due in the queue (called by the Leads page while open). */
export async function drainSendQueue(): Promise<DrainResult> {
  const supabase = await createClient();
  const res = await sendDueQueued(supabase, 10);
  if (res.sent || res.failed) {
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

const NAME_TOKEN = "[NAME]";

/** Swap the shared greeting placeholder for one contact's name. */
function personalize(body: string, contact: Contact): string {
  const name = contact.name?.trim();
  if (body.includes(NAME_TOKEN)) {
    return body.split(NAME_TOKEN).join(name || "there");
  }
  return body;
}

/**
 * Draft outreach for every contact on a lead that has an email and hasn't been
 * emailed or drafted yet. Runs ONE researched generation (written to be sent
 * individually to several people at the same org), then saves a personalized
 * copy per contact so each can be reviewed and edited before sending.
 */
export async function draftForAllContacts(
  leadId: string,
  oneOff?: string,
): Promise<{ created: number; error?: string; styleAdjusted?: boolean }> {
  const lead = await getLead(leadId);
  if (!lead) return { created: 0, error: "Lead not found." };

  const covered = new Set(
    lead.outreach.map((o) => o.contact_id).filter(Boolean) as string[],
  );
  const targets = lead.contacts.filter(
    (c) => looksLikeRealEmail(c.email) && !covered.has(c.id),
  );
  if (targets.length === 0) {
    return {
      created: 0,
      error: "Every contact with an email already has a draft or a sent email.",
    };
  }

  const [rules, voiceInjection] = await Promise.all([
    getActiveRules(),
    getActiveVoiceInjection(),
  ]);

  const multiInstruction = `This same email will be sent individually to ${targets.length} different people at this organization (roles include: ${targets
    .map((c) => c.role ?? "staff")
    .slice(0, 7)
    .join("; ")}). Keep it about the institution and its programs rather than any one person's job, so it reads naturally for each recipient. Open with exactly "Dear ${NAME_TOKEN}," on the first line; that placeholder is replaced with each recipient's name.`;

  try {
    const gen = await generateOutreach({
      lead,
      contact: null,
      rules,
      oneOffInstruction: oneOff ? `${multiInstruction}\n${oneOff}` : multiInstruction,
      voiceInjection,
    });

    // Guarantee the placeholder greeting even if the model ignored it.
    const body = gen.body.includes(NAME_TOKEN)
      ? gen.body
      : gen.body.replace(
          /^\s*(dear|hi|hello|greetings|good (morning|afternoon))\b[^\n]*\n/i,
          `Dear ${NAME_TOKEN},\n`,
        );

    const supabase = await createClient();
    const { error } = await supabase.from("outreach").insert(
      targets.map((c) => ({
        lead_id: leadId,
        contact_id: c.id,
        subject: gen.subject,
        body: personalize(body, c),
        status: "draft",
      })),
    );
    if (error) return { created: 0, error: error.message };

    revalidatePath(`/admin/leads/${leadId}`);
    return { created: targets.length, styleAdjusted: gen.styleAdjusted };
  } catch (e) {
    return {
      created: 0,
      error: e instanceof Error ? e.message : "Failed to draft outreach.",
    };
  }
}

/**
 * Send every unsent draft on a lead that has a valid contact email, one Gmail
 * message per recipient (never CC'd together). EXPLICIT, operator-confirmed.
 */
export async function sendAllDrafts(
  leadId: string,
): Promise<{ sent: number; failed: number; errors: string[] }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("outreach")
    .select("id, status, contact:contacts(email)")
    .eq("lead_id", leadId)
    .in("status", ["draft", "failed"]);

  const rows =
    (data as Array<{ id: string; contact: { email: string | null } | null }> | null) ??
    [];
  const ready = rows.filter((r) => looksLikeRealEmail(r.contact?.email));

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const row of ready) {
    const res = await approveAndSend(row.id);
    if (res.error) {
      failed += 1;
      errors.push(`${row.contact?.email}: ${res.error}`);
    } else {
      sent += 1;
    }
  }
  return { sent, failed, errors };
}
