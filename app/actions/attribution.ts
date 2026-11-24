"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getLead } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth/profile";
import {
  effectiveOrigin,
  firstSentChannel,
  originValueLabel,
  type EffectiveOrigin,
} from "@/lib/attribution";
import type { AttributionOverride, Lead, LeadStatus } from "@/lib/types";

/** Typed to confirm an attribution override change. */
const CONFIRM_WORD = "CONFIRM";
/** Typed (instead of the target's exact name) to confirm a merge. */
const MERGE_WORD = "MERGE";
const MIN_REASON = 10;

async function actor(): Promise<string> {
  const me = await getCurrentUser();
  return me?.email ?? "unknown user";
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function originText(o: EffectiveOrigin): string {
  return `${originValueLabel(o.via)}${o.overridden ? " (override)" : ""}`;
}

// ---- Merge -------------------------------------------------------------------

export interface MergeTargetOption {
  id: string;
  name: string;
  status: LeadStatus;
  location: string | null;
}

/**
 * Leads to merge INTO, by organization name. Excludes this lead and leads
 * that were themselves merged away.
 */
export async function searchMergeTargets(
  sourceId: string,
  query: string,
): Promise<{ results: MergeTargetOption[]; error?: string }> {
  const q = query.trim();
  if (q.length < 2) return { results: [] };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .ilike("name", `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)
    .neq("id", sourceId)
    .order("name", { ascending: true })
    .limit(40);
  if (error) return { results: [], error: error.message };
  return {
    results: ((data as Lead[] | null) ?? [])
      .filter((l) => !l.merged_into_id)
      .slice(0, 20)
      .map((l) => ({
        id: l.id,
        name: l.name,
        status: l.status,
        location:
          [l.location_region, l.location_country].filter(Boolean).join(", ") || null,
      })),
  };
}

export interface MergeSide {
  id: string;
  name: string;
  status: LeadStatus;
  origin: EffectiveOrigin;
  revisitOn: string | null;
}

export interface MergePreview {
  source: MergeSide;
  target: MergeSide;
  /** Contacts that move over as they are. */
  contactsMoving: Array<{ name: string | null; email: string | null }>;
  /** Source contacts whose email the target already has (target's is kept). */
  contactsFolded: Array<{ name: string | null; email: string; into: string | null }>;
  outreach: { total: number; sent: number; appSent: number };
  interactions: number;
  bookings: string[];
  followupSequences: number;
  result: { origin: EffectiveOrigin; status: LeadStatus; revisitOn: string | null };
}

const MERGE_RANK: Partial<Record<LeadStatus, number>> = {
  back_burner: 1,
  interested: 2,
  booked: 3,
  closed: 4,
};

/** Everything that would move, and the attribution the merged lead ends up with. */
export async function previewMerge(
  sourceId: string,
  targetId: string,
): Promise<{ preview?: MergePreview; error?: string }> {
  if (sourceId === targetId) return { error: "Pick a different lead to merge into." };
  const supabase = await createClient();
  const [source, target] = await Promise.all([
    getLead(sourceId, supabase),
    getLead(targetId, supabase),
  ]);
  if (!source || !target) return { error: "Lead not found." };
  if (source.merged_into_id) return { error: "This lead was already merged." };
  if (target.merged_into_id) {
    return { error: "That lead was itself merged into another lead; merge into that one instead." };
  }

  const [inter, seqs] = await Promise.all([
    supabase
      .from("interactions")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", sourceId),
    supabase
      .from("followup_sequences")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", sourceId),
  ]);

  const key = (e: string | null) => e?.trim().toLowerCase() || null;
  const targetByEmail = new Map(
    target.contacts.filter((c) => key(c.email)).map((c) => [key(c.email) as string, c]),
  );
  const contactsMoving: MergePreview["contactsMoving"] = [];
  const contactsFolded: MergePreview["contactsFolded"] = [];
  for (const c of source.contacts) {
    const match = key(c.email) ? targetByEmail.get(key(c.email) as string) : undefined;
    if (match) {
      contactsFolded.push({ name: c.name, email: c.email as string, into: match.name });
    } else {
      contactsMoving.push({ name: c.name, email: c.email });
    }
  }

  const side = (l: typeof source): MergeSide => ({
    id: l.id,
    name: l.name,
    status: l.status,
    origin: effectiveOrigin(l, firstSentChannel(l.outreach)),
    revisitOn: l.revisit_on ?? null,
  });
  const sent = source.outreach.filter((o) => o.status === "sent");
  const overrideFrom = target.attribution_override ? target : source;
  const resultStatus =
    (MERGE_RANK[source.status] ?? 0) > (MERGE_RANK[target.status] ?? 0)
      ? source.status
      : target.status;

  return {
    preview: {
      source: side(source),
      target: side(target),
      contactsMoving,
      contactsFolded,
      outreach: {
        total: source.outreach.length,
        sent: sent.length,
        appSent: sent.filter((o) => o.sent_via === "app").length,
      },
      interactions: inter.count ?? 0,
      bookings: source.bookings.map((b) => b.event_name),
      followupSequences: seqs.count ?? 0,
      result: {
        origin: effectiveOrigin(
          overrideFrom,
          firstSentChannel([...source.outreach, ...target.outreach]),
        ),
        status: resultStatus,
        revisitOn: target.revisit_on ?? source.revisit_on ?? null,
      },
    },
  };
}

/**
 * Merge a duplicate lead (source) into another (target). The confirmation
 * must be the target's exact name or the word MERGE. All moves happen in one
 * database transaction (merge_leads, migration 0034); the source is kept as
 * status Junk with merged_into_id set, never deleted.
 */
export async function mergeLeadInto(
  sourceId: string,
  targetId: string,
  confirmation: string,
): Promise<{ error?: string; summary?: string }> {
  if (sourceId === targetId) return { error: "Pick a different lead to merge into." };
  const supabase = await createClient();
  const { data: target } = await supabase
    .from("leads")
    .select("id, name")
    .eq("id", targetId)
    .maybeSingle();
  const t = target as { id: string; name: string } | null;
  if (!t) return { error: "Target lead not found." };
  const typed = confirmation.trim();
  if (typed !== t.name.trim() && typed !== MERGE_WORD) {
    return { error: `Type the target's exact name ("${t.name}") or ${MERGE_WORD} to confirm.` };
  }

  const { data, error } = await supabase.rpc("merge_leads", {
    p_source: sourceId,
    p_target: targetId,
    p_actor: await actor(),
  });
  if (error) {
    return {
      error: /merge_leads|function/i.test(error.message)
        ? `Merge is unavailable until database migration 0034 is applied (${error.message}).`
        : error.message,
    };
  }
  const r = (data ?? {}) as Record<string, number | string>;
  revalidatePath(`/admin/leads/${sourceId}`);
  revalidatePath(`/admin/leads/${targetId}`);
  revalidatePath("/admin/leads");
  revalidatePath("/admin");
  return {
    summary: `Merged. Moved ${r.contacts ?? 0} contacts (${r.duplicates ?? 0} folded into existing), ${
      r.outreach ?? 0
    } outreach, ${r.interactions ?? 0} interactions, ${r.bookings ?? 0} bookings.`,
  };
}

// ---- Attribution override -----------------------------------------------------

async function loadForOverride(leadId: string) {
  const supabase = await createClient();
  const lead = await getLead(leadId, supabase);
  if (!lead) return { error: "Lead not found." as const };
  if (lead.merged_into_id) {
    return { error: "This lead was merged into another lead; edit attribution there." as const };
  }
  return { supabase, lead, computed: firstSentChannel(lead.outreach) };
}

/**
 * Explicit attribution override. Needs a value, a reason of at least 10
 * characters and the word CONFIRM. Never touches outreach rows (sent_via).
 */
export async function setAttributionOverride(
  leadId: string,
  value: AttributionOverride,
  reason: string,
  confirmation: string,
): Promise<{ error?: string }> {
  if (value !== "app" && value !== "not_app") return { error: "Choose an attribution." };
  const why = reason.trim();
  if (why.length < MIN_REASON) {
    return { error: `Give a reason of at least ${MIN_REASON} characters.` };
  }
  if (confirmation.trim() !== CONFIRM_WORD) return { error: `Type ${CONFIRM_WORD} to confirm.` };

  const loaded = await loadForOverride(leadId);
  if ("error" in loaded) return { error: loaded.error };
  const { supabase, lead, computed } = loaded;
  const before = effectiveOrigin(lead, computed);
  const who = await actor();
  const at = new Date().toISOString();

  const { error } = await supabase
    .from("leads")
    .update({
      attribution_override: value,
      attribution_override_reason: why,
      attribution_override_by: who,
      attribution_override_at: at,
    })
    .eq("id", leadId);
  if (error) {
    return {
      error: /attribution_override/.test(error.message)
        ? "Attribution overrides need database migration 0034 to be applied first."
        : error.message,
    };
  }
  const after = effectiveOrigin({ attribution_override: value }, computed);
  await supabase.from("interactions").insert({
    lead_id: leadId,
    kind: "note",
    detail: `Attribution override set by ${who} on ${stamp()}: ${originText(before)} -> ${originText(
      after,
    )}. Reason: ${why}. First sent outreach channel (unchanged): ${originValueLabel(computed)}.`,
  });
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  return {};
}

/** Remove the override; the lead goes back to its first sent outreach. Needs CONFIRM. */
export async function clearAttributionOverride(
  leadId: string,
  reason: string,
  confirmation: string,
): Promise<{ error?: string }> {
  if (confirmation.trim() !== CONFIRM_WORD) return { error: `Type ${CONFIRM_WORD} to confirm.` };
  const loaded = await loadForOverride(leadId);
  if ("error" in loaded) return { error: loaded.error };
  const { supabase, lead, computed } = loaded;
  if (!lead.attribution_override) return { error: "There is no override to clear." };
  const before = effectiveOrigin(lead, computed);
  const who = await actor();

  const { error } = await supabase
    .from("leads")
    .update({
      attribution_override: null,
      attribution_override_reason: null,
      attribution_override_by: null,
      attribution_override_at: null,
    })
    .eq("id", leadId);
  if (error) return { error: error.message };

  const why = reason.trim();
  await supabase.from("interactions").insert({
    lead_id: leadId,
    kind: "note",
    detail: `Attribution override cleared by ${who} on ${stamp()}: ${originText(before)} -> ${originValueLabel(
      computed,
    )} (first sent outreach).${why ? ` Reason: ${why}.` : ""}`,
  });
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  return {};
}
