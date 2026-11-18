import { createAdminClient } from "@/lib/supabase/admin";
import type {
  CandidateRecord,
  DiscoveryProgress,
  StopReason,
} from "@/lib/claude/discovery";
import type { ContactStatus, DiscoveredLead, LeadType } from "@/lib/types";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface DiscoverySummary extends DiscoveryProgress {
  /** discovery_runs id, or null when the run could not be recorded. */
  runId: string | null;
  requested: number;
  inserted: number;
  needsLookup: number;
  stopReason: StopReason;
  /** Distinct search errors (timeouts, API failures). */
  errors: string[];
  /** Every candidate the models proposed and what happened to it. */
  candidates: CandidateRecord[];
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
  /** Queue the lead for contact finding + drafting (needs migration 0030). */
  queueEnrich = false,
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
      ...(queueEnrich ? { enrich_status: "pending" } : {}),
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
 * Open a discovery_runs row for this run. Returns null when the table (or its
 * 0030 columns) is missing, so discovery still runs untracked.
 */
export async function startDiscoveryRun(
  admin: AdminClient,
  requested: number,
  focus: string | undefined,
  autoEnrich: boolean,
): Promise<string | null> {
  const { data, error } = await admin
    .from("discovery_runs")
    .insert({ requested, focus: focus ?? null, auto_enrich: autoEnrich })
    .select("id")
    .single();
  if (error || !data) {
    console.warn(
      `[discover] run not recorded (apply supabase/migrations/0030_discovery_tracking.sql): ${error?.message ?? "no row"}`,
    );
    return null;
  }
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
    duplicates?: number;
    repeats?: number;
    rule_filtered?: number;
    surplus?: number;
    rounds?: number;
    searches?: number;
    stop_reason?: StopReason;
    candidates?: CandidateRecord[];
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

/** Has the operator pressed Stop on this run? */
export async function discoveryStopRequested(
  admin: AdminClient,
  runId: string | null,
): Promise<boolean> {
  if (!runId) return false;
  const { data } = await admin
    .from("discovery_runs")
    .select("cancel_requested")
    .eq("id", runId)
    .maybeSingle();
  return Boolean((data as { cancel_requested?: boolean } | null)?.cancel_requested);
}
