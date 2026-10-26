import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveRules, getExistingLeadKeys } from "@/lib/data";
import { discoverLeads } from "@/lib/claude/discovery";
import {
  insertDiscoveredLead,
  startDiscoveryRun,
  updateDiscoveryRun,
  type DiscoverySummary,
} from "@/lib/discovery/persist";

export const dynamic = "force-dynamic";
// Discovery does long web-search runs. Allow up to 5 min (effective on Vercel
// Pro/Enterprise; Hobby caps lower — see README).
export const maxDuration = 300;

/**
 * Streams discovered leads as newline-delimited JSON (NDJSON), one event per
 * line, so the UI can render each lead the moment it's generated instead of
 * waiting for the whole batch. The run and its leads are also recorded in
 * discovery_runs, so the Discover page can show them after a refresh or after
 * the browser disconnects (the server keeps going until the function times
 * out). Events:
 *   { type: "lead",  lead: InsertedLead }
 *   { type: "done",  summary: DiscoverySummary }
 *   { type: "error", error: string }
 * Auth is enforced upstream by the proxy (unauthenticated requests are
 * redirected to /login before reaching this handler).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    count?: unknown;
    focus?: unknown;
  };
  const requested = Math.max(1, Math.min(Number(body.count) || 5, 100));
  const focusText =
    typeof body.focus === "string" && body.focus.trim()
      ? body.focus.trim()
      : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // client disconnected — stop trying to write
          closed = true;
        }
      };

      const admin = createAdminClient();
      let runId: string | null = null;
      try {
        runId = await startDiscoveryRun(admin, requested, focusText);
        const [rules, existing] = await Promise.all([
          getActiveRules(),
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
          onLead: async (lead) => {
            const row = await insertDiscoveredLead(admin, lead, detail, runId);
            if (!row) return;
            inserted += 1;
            if (row.needsLookup) needsLookup += 1;
            await updateDiscoveryRun(admin, runId, { inserted });
            send({ type: "lead", lead: row });
          },
        });

        const summary: DiscoverySummary = {
          inserted,
          failedBatches: result.failedBatches,
          rawCount: result.rawCount,
          requested,
          needsLookup,
        };
        await updateDiscoveryRun(admin, runId, {
          status: "done",
          inserted,
          raw_count: result.rawCount,
          failed_batches: result.failedBatches,
        });
        send({ type: "done", summary });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Discovery failed.";
        await updateDiscoveryRun(admin, runId, {
          status: "error",
          error: message,
        }).catch(() => {});
        send({ type: "error", error: message });
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
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
