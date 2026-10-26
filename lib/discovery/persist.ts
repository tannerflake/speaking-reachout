import { createAdminClient } from "@/lib/supabase/admin";
import type { ContactStatus, DiscoveredLead, LeadType } from "@/lib/types";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface DiscoverySummary {
  inserted: number;
  failedBatches: number;
  rawCount: number;
  requested: number;
  needsLookup: number;
  error?: string;
}

/** Shape streamed to the client as each lead lands. */
export interface InsertedLead {
  id: string;
  name: string;
  type: LeadType;
  location_country: string | null;
  location_region: string | null;
  website: string | null;
  contact_status: ContactStatus;
  needsLookup: boolean;
}

/**
 * Persist one discovered lead (+ its contact + a "discovered" interaction).
 * Returns a compact row for streaming, or null if the lead insert failed.
 */
export async function insertDiscoveredLead(
  admin: AdminClient,
  lead: DiscoveredLead,
  detail: string,
  runId: string | null = null,
): Promise<InsertedLead | null> {
  const { data, error } = await admin
    .from("leads")
    .insert({
      name: lead.name,
      type: lead.type,
      description: lead.description,
      location_country: lead.location_country || null,
      location_region: lead.location_region,
      website: lead.website,
      source_url: lead.source_url,
      fit_rationale: lead.fit_rationale,
      suggested_topics: lead.suggested_topics,
      status: "new",
      // Only set when the run row exists, so discovery keeps working before
      // migration 0027 is applied.
      ...(runId ? { discovery_run_id: runId } : {}),
    })
    .select("id")
    .single();
  if (error || !data) return null;

  const leadId = (data as { id: string }).id;
  const contact = lead.contact;
  const contactStatus: ContactStatus = contact?.contact_status ?? "needs_lookup";

  await admin.from("contacts").insert({
    lead_id: leadId,
    name: contact?.name ?? null,
    role: contact?.role ?? null,
    email: contact?.email ?? null,
    contact_status: contactStatus,
    source_url: contact?.source_url ?? null,
  });

  await admin.from("interactions").insert({
    lead_id: leadId,
    kind: "discovered",
    detail,
  });

  return {
    id: leadId,
    name: lead.name,
    type: lead.type,
    location_country: lead.location_country || null,
    location_region: lead.location_region,
    website: lead.website,
    contact_status: contactStatus,
    needsLookup: !contact?.email || contactStatus === "needs_lookup",
  };
}

/**
 * Open a discovery_runs row for this run. Returns null when the table is
 * missing (migration 0027 not applied) so discovery still runs untracked.
 */
export async function startDiscoveryRun(
  admin: AdminClient,
  requested: number,
  focus: string | undefined,
): Promise<string | null> {
  const { data, error } = await admin
    .from("discovery_runs")
    .insert({ requested, focus: focus ?? null })
    .select("id")
    .single();
  if (error || !data) return null;
  return (data as { id: string }).id;
}

/** Best-effort update of a run's progress or final outcome. */
export async function updateDiscoveryRun(
  admin: AdminClient,
  runId: string | null,
  patch: {
    status?: "done" | "error";
    inserted?: number;
    raw_count?: number;
    failed_batches?: number;
    error?: string;
  },
): Promise<void> {
  if (!runId) return;
  const finished = patch.status ? { finished_at: new Date().toISOString() } : {};
  await admin
    .from("discovery_runs")
    .update({ ...patch, ...finished })
    .eq("id", runId);
}
