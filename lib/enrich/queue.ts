import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";
import { enrichLeadCore, type EnrichResult } from "@/lib/enrich/pipeline";

/**
 * Server-side queue for "find contacts + draft outreach" (enrichment).
 *
 * A lead is queued by setting leads.enrich_status = 'pending' (Discover does
 * this as it inserts each lead). Workers are invocations of POST /api/enrich:
 * each one claims a single pending lead, processes it inside its own function
 * time limit, then starts a successor if anything is still pending. Because
 * the queue lives in the database and the workers call each other, it keeps
 * going when the operator closes the tab or starts another Discover run.
 *
 * Requires migration 0030; enrichQueueAvailable() says whether it is applied.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

// Leads processed at once. Each is one cheap-model contact search (plus the
// other providers) and one Opus drafting call, so this stays well inside the
// API rate limits even while a Discover run is searching.
export const ENRICH_CONCURRENCY = 5;
// A lead is tried this many times before it is parked as "error".
const MAX_ATTEMPTS = 2;
// Workers run under a 300s function limit; a lead still "working" past this
// was cut off and is handed to another worker.
const STALE_MS = 6 * 60 * 1000;
// What one worker allows a lead (the route's maxDuration is 300s).
const LEAD_BUDGET_MS = 280_000;

/** How to reach POST /api/enrich from server code. */
export interface KickContext {
  origin: string;
  headers: Record<string, string>;
}

/**
 * Build the self-call context from the current request's headers. Uses the
 * CRON_SECRET bearer when configured; otherwise forwards the operator's
 * session cookie so the worker route can still authenticate the call.
 */
export function kickContext(headers: Headers): KickContext {
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost:3000";
  const proto =
    headers.get("x-forwarded-proto")?.split(",")[0] ??
    (/^(localhost|127\.)/.test(host) ? "http" : "https");
  const out: Record<string, string> = { "Content-Type": "application/json" };
  const secret = getEnv("CRON_SECRET");
  const cookie = headers.get("cookie");
  if (secret) out.Authorization = `Bearer ${secret}`;
  else if (cookie) out.Cookie = cookie;
  return { origin: `${proto}://${host}`, headers: out };
}

let _available: boolean | null = null;

/** True once migration 0030 (leads.enrich_status) is applied. */
export async function enrichQueueAvailable(db: Db): Promise<boolean> {
  if (_available) return true;
  const { error } = await db.from("leads").select("enrich_status").limit(1);
  _available = !error;
  return _available;
}

/** Hand leads whose worker died back to the queue (or park them). */
async function reclaimStale(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data } = await db
    .from("leads")
    .select("id, enrich_attempts")
    .eq("enrich_status", "working")
    .lt("enrich_started_at", cutoff);
  for (const row of (data as Array<{ id: string; enrich_attempts: number }> | null) ?? []) {
    const retry = row.enrich_attempts < MAX_ATTEMPTS;
    await db
      .from("leads")
      .update(
        retry
          ? { enrich_status: "pending" }
          : {
              enrich_status: "error",
              enrich_finished_at: new Date().toISOString(),
              enrich_error:
                "Timed out while finding contacts and drafting. Use Retry to run it again.",
            },
      )
      .eq("id", row.id)
      .eq("enrich_status", "working");
  }
}

async function queueCounts(db: Db): Promise<{ pending: number; working: number }> {
  const [pending, working] = await Promise.all([
    db.from("leads").select("id", { count: "exact", head: true }).eq("enrich_status", "pending"),
    db.from("leads").select("id", { count: "exact", head: true }).eq("enrich_status", "working"),
  ]);
  return { pending: pending.count ?? 0, working: working.count ?? 0 };
}

/**
 * Atomically take one lead: flips pending -> working only if it is still
 * pending, so two workers can never process the same lead.
 */
async function claim(db: Db, row: { id: string; enrich_attempts: number }): Promise<boolean> {
  const { data } = await db
    .from("leads")
    .update({
      enrich_status: "working",
      enrich_started_at: new Date().toISOString(),
      enrich_attempts: (row.enrich_attempts ?? 0) + 1,
      enrich_error: null,
    })
    .eq("id", row.id)
    .eq("enrich_status", "pending")
    .select("id");
  return ((data as unknown[] | null) ?? []).length > 0;
}

async function claimNext(db: Db): Promise<string | null> {
  const { data } = await db
    .from("leads")
    .select("id, enrich_attempts")
    .eq("enrich_status", "pending")
    .order("created_at", { ascending: true })
    .limit(ENRICH_CONCURRENCY * 2);
  for (const row of (data as Array<{ id: string; enrich_attempts: number }> | null) ?? []) {
    if (await claim(db, row)) return row.id;
  }
  return null;
}

/** Run the pipeline for a lead already marked working, and record the outcome. */
async function processClaimed(db: Db, leadId: string): Promise<EnrichResult> {
  let result: EnrichResult;
  try {
    result = await enrichLeadCore(db, leadId, { deadline: Date.now() + LEAD_BUDGET_MS });
  } catch (e) {
    result = {
      leadId,
      contactsAdded: 0,
      contactsWithEmail: 0,
      draftsCreated: 0,
      hunterUsed: false,
      missingDrafts: 0,
      error: e instanceof Error ? e.message : "Failed to find contacts and draft.",
    };
  }

  const { data } = await db
    .from("leads")
    .select("enrich_attempts")
    .eq("id", leadId)
    .maybeSingle();
  const attempts = (data as { enrich_attempts?: number } | null)?.enrich_attempts ?? MAX_ATTEMPTS;
  // A failure gets one automatic retry; a guard refusal never changes on retry.
  const retry = Boolean(result.error) && !result.blocked && attempts < MAX_ATTEMPTS;
  await db
    .from("leads")
    .update(
      retry
        ? { enrich_status: "pending", enrich_error: result.error }
        : {
            enrich_status: result.error ? "error" : "done",
            enrich_finished_at: new Date().toISOString(),
            enrich_error: result.error ?? null,
          },
    )
    .eq("id", leadId);
  return result;
}

/**
 * Process one specific lead right now (the Leads page "prepare" actions and
 * the pre-migration fallback). Marks the queue columns when they exist so the
 * background workers leave the lead alone.
 */
export async function enrichLeadNow(db: Db, leadId: string): Promise<EnrichResult> {
  if (!(await enrichQueueAvailable(db))) {
    return enrichLeadCore(db, leadId, { deadline: Date.now() + LEAD_BUDGET_MS });
  }
  const { data } = await db
    .from("leads")
    .select("enrich_status, enrich_started_at")
    .eq("id", leadId)
    .maybeSingle();
  const row = data as { enrich_status: string | null; enrich_started_at: string | null } | null;
  const busyResult: EnrichResult = {
    leadId,
    contactsAdded: 0,
    contactsWithEmail: 0,
    draftsCreated: 0,
    hunterUsed: false,
    missingDrafts: 0,
    error: "Contacts and drafts for this lead are already being prepared in the background.",
  };
  const busy =
    row?.enrich_status === "working" &&
    row.enrich_started_at !== null &&
    Date.now() - new Date(row.enrich_started_at).getTime() < STALE_MS;
  if (!row || busy) return row ? busyResult : { ...busyResult, error: "Lead not found." };

  // Take the lead only if its state is still the one just read, so this can
  // never run alongside a queue worker that claimed it in between.
  const take = db
    .from("leads")
    .update({
      enrich_status: "working",
      enrich_started_at: new Date().toISOString(),
      // An explicit request is never auto-retried.
      enrich_attempts: MAX_ATTEMPTS,
      enrich_error: null,
    })
    .eq("id", leadId);
  const { data: taken } = await (row.enrich_status === null
    ? take.is("enrich_status", null)
    : take.eq("enrich_status", row.enrich_status)
  ).select("id");
  if (((taken as unknown[] | null) ?? []).length === 0) return busyResult;
  return processClaimed(db, leadId);
}

/**
 * One worker's life: claim a pending lead (unless enough workers are already
 * busy), process it, then make sure the rest of the queue has workers.
 */
export async function runEnrichWorker(db: Db, ctx: KickContext): Promise<void> {
  if (!(await enrichQueueAvailable(db))) return;
  const { working } = await queueCounts(db);
  if (working >= ENRICH_CONCURRENCY) return;
  const leadId = await claimNext(db);
  if (!leadId) return;
  try {
    await processClaimed(db, leadId);
  } finally {
    await kickEnrichWorkers(db, ctx);
  }
}

/**
 * Start as many workers as the queue needs (up to the concurrency cap).
 * Cheap and safe to call often: an extra worker that finds nothing to claim
 * exits at once. Returns how many were started.
 */
export async function kickEnrichWorkers(db: Db, ctx: KickContext): Promise<number> {
  try {
    if (!(await enrichQueueAvailable(db))) return 0;
    await reclaimStale(db);
    const { pending, working } = await queueCounts(db);
    const n = Math.min(ENRICH_CONCURRENCY - working, pending);
    if (n <= 0) return 0;
    const results = await Promise.allSettled(
      Array.from({ length: n }, () =>
        // The worker route answers 202 at once and does its work afterwards,
        // so this only waits for the hand-off.
        fetch(`${ctx.origin}/api/enrich`, {
          method: "POST",
          headers: ctx.headers,
          body: JSON.stringify({ worker: true }),
          signal: AbortSignal.timeout(15_000),
        }).then((res) => {
          if (!res.ok) throw new Error(`worker start failed (${res.status})`);
        }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      console.warn(
        `[enrich] ${failed.length} of ${n} workers failed to start: ${String(
          (failed[0] as PromiseRejectedResult).reason,
        )}`,
      );
    }
    return n - failed.length;
  } catch (e) {
    console.warn(`[enrich] kick failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

/** Put leads (back) on the queue, e.g. the Retry button on a Discover run. */
export async function requeueLeads(db: Db, leadIds: string[]): Promise<number> {
  if (leadIds.length === 0 || !(await enrichQueueAvailable(db))) return 0;
  const { data } = await db
    .from("leads")
    .update({ enrich_status: "pending", enrich_attempts: 0, enrich_error: null })
    .in("id", leadIds)
    .or("enrich_status.is.null,enrich_status.in.(done,error)")
    .select("id");
  return ((data as unknown[] | null) ?? []).length;
}
