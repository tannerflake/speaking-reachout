import { createAdminClient } from "@/lib/supabase/admin";
import type {
  BacklogCandidate,
  CandidateOutcome,
  CandidateRecord,
  DiscoveryProgress,
  StopReason,
} from "@/lib/claude/discovery";
import type { ContactStatus, DiscoveredLead, LeadType } from "@/lib/types";
import { normalizeName } from "@/lib/utils";

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
  /** Extras saved for the next run (0 before migration 0033). */
  backlogSaved: number;
  /** Warnings that don't stop the run (e.g. Hunter out of searches). */
  warnings: string[];
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
    reused?: number;
    rounds?: number;
    searches?: number;
    stop_reason?: StopReason;
    candidates?: CandidateRecord[];
    error?: string;
  },
): Promise<void> {
  if (!runId) return;
  const finished = patch.status ? { finished_at: new Date().toISOString() } : {};
  const { error } = await admin
    .from("discovery_runs")
    .update({ ...patch, ...finished })
    .eq("id", runId);
  if (error && "reused" in patch) {
    // Before migration 0033 there is no "reused" column; save the rest.
    const { reused: _reused, ...rest } = patch;
    void _reused;
    await admin
      .from("discovery_runs")
      .update({ ...rest, ...finished })
      .eq("id", runId);
  }
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

// --- Saved extras (discovery_candidates, migration 0033) --------------------

/** Saved extras older than this are not reused (venues and staff change). */
export const BACKLOG_MAX_AGE_DAYS = 14;

export interface BacklogContext {
  focus: string | undefined;
  focusKey: string;
  rulesKey: string;
  rulesSnapshot: unknown[];
}

/**
 * Save the valid extras a run found after reaching its target, so the next
 * run with the same focus and rules uses them before searching. Best-effort:
 * without migration 0033 they are dropped as before. Returns how many saved.
 */
export async function saveDiscoveryBacklog(
  admin: AdminClient,
  runId: string | null,
  leads: DiscoveredLead[],
  ctx: BacklogContext,
): Promise<number> {
  if (leads.length === 0) return 0;
  // Skip orgs already waiting in the backlog under the same key.
  const { data: waiting, error: readError } = await admin
    .from("discovery_candidates")
    .select("name_normalized")
    .eq("status", "available")
    .eq("focus_key", ctx.focusKey)
    .eq("rules_key", ctx.rulesKey);
  if (readError) {
    console.warn(
      `[discover] extras not saved (apply supabase/migrations/0033_discovery_backlog_and_usage.sql): ${readError.message}`,
    );
    return 0;
  }
  const taken = new Set(
    ((waiting as Array<{ name_normalized: string }> | null) ?? []).map((r) => r.name_normalized),
  );
  const rows = [];
  for (const lead of leads) {
    const key = normalizeName(lead.name);
    if (!key || taken.has(key)) continue;
    taken.add(key);
    rows.push({
      run_id: runId,
      name: lead.name,
      name_normalized: key,
      candidate: lead,
      focus: ctx.focus ?? null,
      focus_key: ctx.focusKey,
      rules_key: ctx.rulesKey,
      rules_snapshot: ctx.rulesSnapshot,
    });
  }
  if (rows.length === 0) return 0;
  const { error } = await admin.from("discovery_candidates").insert(rows);
  if (error) {
    console.warn(`[discover] extras not saved: ${error.message}`);
    return 0;
  }
  return rows.length;
}

/**
 * Claim up to `limit` saved extras matching this run's focus and rules and
 * under BACKLOG_MAX_AGE_DAYS old, newest first. Claimed rows can't be taken
 * by a concurrent run; settleDiscoveryBacklog releases or retires them.
 */
export async function claimDiscoveryBacklog(
  admin: AdminClient,
  runId: string | null,
  ctx: BacklogContext,
  limit: number,
): Promise<BacklogCandidate[]> {
  const since = new Date(Date.now() - BACKLOG_MAX_AGE_DAYS * 86_400_000).toISOString();
  // A run that died mid-claim (runs last at most 5 minutes) frees its rows.
  await admin
    .from("discovery_candidates")
    .update({ status: "available", claimed_run_id: null, claimed_at: null })
    .eq("status", "claimed")
    .lt("claimed_at", new Date(Date.now() - 60 * 60_000).toISOString());
  const { data, error } = await admin
    .from("discovery_candidates")
    .select("id")
    .eq("status", "available")
    .eq("focus_key", ctx.focusKey)
    .eq("rules_key", ctx.rulesKey)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data || data.length === 0) return [];
  const ids = (data as Array<{ id: string }>).map((r) => r.id);
  const { data: claimed } = await admin
    .from("discovery_candidates")
    .update({ status: "claimed", claimed_run_id: runId, claimed_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "available")
    .select("id, candidate, created_at");
  return ((claimed as Array<{ id: string; candidate: DiscoveredLead; created_at: string }> | null) ?? [])
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => ({ id: r.id, lead: r.candidate }));
}

/**
 * After a run: extras it added are "used", extras that failed the dedupe or
 * rule checks are "rejected" (with the reason), and anything it didn't get
 * to goes back to "available".
 */
export async function settleDiscoveryBacklog(
  admin: AdminClient,
  runId: string | null,
  claimed: BacklogCandidate[],
  outcomes: Map<string, { outcome: CandidateOutcome; reason: string }>,
): Promise<void> {
  const now = new Date().toISOString();
  const release: string[] = [];
  for (const b of claimed) {
    const o = outcomes.get(b.id);
    if (!o || o.outcome === "surplus" || o.outcome === "failed") {
      release.push(b.id);
    } else if (o.outcome === "added") {
      await admin
        .from("discovery_candidates")
        .update({ status: "used", used_run_id: runId, settled_at: now })
        .eq("id", b.id);
    } else {
      await admin
        .from("discovery_candidates")
        .update({ status: "rejected", reject_reason: o.reason.slice(0, 300), settled_at: now })
        .eq("id", b.id);
    }
  }
  if (release.length > 0) {
    await admin
      .from("discovery_candidates")
      .update({ status: "available", claimed_run_id: null, claimed_at: null })
      .in("id", release);
  }
}
