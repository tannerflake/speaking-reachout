import { after, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveRules, getExistingLeadKeys } from "@/lib/data";
import { discoverLeads } from "@/lib/claude/discovery";
import {
  discoveryStopRequested,
  insertDiscoveredLead,
  startDiscoveryRun,
  updateDiscoveryRun,
  type DiscoverySummary,
} from "@/lib/discovery/persist";
import {
  enrichQueueAvailable,
  kickContext,
  kickEnrichWorkers,
  type KickContext,
} from "@/lib/enrich/queue";

export const dynamic = "force-dynamic";
// Discovery searches in rounds until it has the requested number of new
// leads. 300s is the most every Vercel plan allows; the run budgets itself
// to finish (and record why it stopped) inside that.
export const maxDuration = 300;
const RUN_BUDGET_MS = 240_000;

/**
 * Runs a Discover job and streams it as newline-delimited JSON (NDJSON), one
 * event per line, so the UI can render progress the moment it happens. The
 * job itself is registered with `after()`: it keeps running on the server if
 * the browser navigates away or the tab is closed, and it records itself in
 * discovery_runs, where the Discover page picks it up again. Events:
 *   { type: "run",      runId, queued }   run opened (queued = contacts and
 *                                         drafts are handled server-side)
 *   { type: "lead",     lead: InsertedLead }
 *   { type: "progress", progress: DiscoveryProgress }
 *   { type: "done",     summary: DiscoverySummary }
 *   { type: "error",    error: string }
 * Auth is enforced upstream by the proxy (unauthenticated requests are
 * redirected to /login before reaching this handler).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    count?: unknown;
    focus?: unknown;
    autoEnrich?: unknown;
  };
  const requested = Math.max(1, Math.min(Number(body.count) || 5, 100));
  const focusText =
    typeof body.focus === "string" && body.focus.trim()
      ? body.focus.trim()
      : undefined;
  const autoEnrich = body.autoEnrich === true;

  // Events are buffered until the stream attaches, then written straight
  // through; once the client is gone they are simply dropped.
  const encoder = new TextEncoder();
  let sink: ((line: Uint8Array) => void) | null = null;
  let detached = false;
  const backlog: Uint8Array[] = [];
  const send = (obj: unknown) => {
    if (detached) return;
    const line = encoder.encode(JSON.stringify(obj) + "\n");
    if (sink) sink(line);
    else backlog.push(line);
  };

  const job = runDiscovery({
    requested,
    focusText,
    autoEnrich,
    ctx: kickContext(req.headers),
    send,
  });
  // Keep the function alive until the job finishes, whatever the client does.
  after(() => job);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = (line) => {
        try {
          controller.enqueue(line);
        } catch {
          // client disconnected: stop writing, the job carries on
          detached = true;
        }
      };
      for (const line of backlog.splice(0)) sink(line);
      void job.finally(() => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      detached = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Disable proxy buffering so events flush as they're produced.
      "X-Accel-Buffering": "no",
    },
  });
}

/** The whole Discover job. Never rejects: failures are recorded and sent. */
async function runDiscovery(opts: {
  requested: number;
  focusText: string | undefined;
  autoEnrich: boolean;
  ctx: KickContext;
  send: (obj: unknown) => void;
}): Promise<void> {
  const { requested, focusText, autoEnrich, ctx, send } = opts;
  const admin = createAdminClient();
  let runId: string | null = null;
  try {
    runId = await startDiscoveryRun(admin, requested, focusText, autoEnrich);
    // With migration 0030 applied, contacts + drafts go through the
    // server-side queue. Without it the page falls back to driving them.
    const queued = autoEnrich && (await enrichQueueAvailable(admin));
    send({ type: "run", runId, queued });

    const [rules, existing] = await Promise.all([
      getActiveRules(admin),
      getExistingLeadKeys(),
    ]);
    const detail = focusText
      ? `Discovered via focus "${focusText}".`
      : "Discovered via Discover.";

    let inserted = 0;
    let needsLookup = 0;

    const result = await discoverLeads({
      count: requested,
      focus: focusText,
      rules,
      existing,
      budgetMs: RUN_BUDGET_MS,
      shouldStop: () => discoveryStopRequested(admin, runId),
      onLead: async (lead) => {
        const row = await insertDiscoveredLead(admin, lead, detail, runId, queued);
        if (!row) return false;
        inserted += 1;
        if (row.needsLookup) needsLookup += 1;
        send({ type: "lead", lead: row });
        // Start on this lead's contacts and drafts while discovery continues.
        if (queued) await kickEnrichWorkers(admin, ctx);
        return true;
      },
      onProgress: async (progress) => {
        send({ type: "progress", progress });
        await updateDiscoveryRun(admin, runId, {
          inserted: progress.added,
          raw_count: progress.rawCount,
          failed_batches: progress.failedBatches,
          duplicates: progress.duplicates,
          repeats: progress.repeats,
          rule_filtered: progress.ruleFiltered,
          surplus: progress.surplus,
          rounds: progress.rounds,
          searches: progress.searches,
        });
      },
    });

    const { leads: _leads, ...counts } = result;
    void _leads;
    const summary: DiscoverySummary = {
      ...counts,
      runId,
      requested,
      inserted,
      needsLookup,
    };
    await updateDiscoveryRun(admin, runId, {
      status: "done",
      inserted,
      raw_count: result.rawCount,
      failed_batches: result.failedBatches,
      duplicates: result.duplicates,
      repeats: result.repeats,
      rule_filtered: result.ruleFiltered,
      surplus: result.surplus,
      rounds: result.rounds,
      searches: result.searches,
      stop_reason: result.stopReason,
      candidates: result.candidates,
      ...(result.errors.length > 0 ? { error: result.errors.join("; ") } : {}),
    });
    if (queued) await kickEnrichWorkers(admin, ctx);
    send({ type: "done", summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Discovery failed.";
    console.error(`[discover] run failed: ${message}`);
    await updateDiscoveryRun(admin, runId, {
      status: "error",
      error: message,
    }).catch(() => {});
    send({ type: "error", error: message });
  }
}
