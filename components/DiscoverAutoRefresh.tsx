"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { pokeEnrichQueue } from "@/app/actions/pipeline";
import { ENRICH_PARALLEL, enrichLeadViaApi } from "@/lib/enrich/client";

const REFRESH_MS = 5_000;
const POKE_EVERY = 6; // refreshes between queue pokes (~30s)
// Refreshes with leads waiting and no worker running before this page
// starts processing them itself (~45s).
const STALLED_AFTER = 9;

/**
 * Keeps the Discover page live while work is happening on the server: a run
 * still searching, or leads waiting on contacts + drafts. Re-reads the page
 * data every few seconds and periodically nudges the enrichment queue.
 *
 * Last resort: if leads sit in the queue with no server worker picking them
 * up, this page processes them directly, so a queue that cannot start its
 * own workers degrades to "works while the page is open" instead of stalling.
 */
export function DiscoverAutoRefresh({
  active,
  stalledLeadIds,
}: {
  active: boolean;
  /** Leads waiting in the queue while no worker is running at all. */
  stalledLeadIds: string[];
}) {
  const router = useRouter();
  const stalled = useRef<string[]>(stalledLeadIds);
  const stalledTicks = useRef(0);
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    stalled.current = stalledLeadIds;
    if (stalledLeadIds.length === 0) stalledTicks.current = 0;
  }, [stalledLeadIds]);

  useEffect(() => {
    if (!active) return;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (stalled.current.length > 0) {
        stalledTicks.current += 1;
        if (ticks % POKE_EVERY === 0) void pokeEnrichQueue();
        if (stalledTicks.current >= STALLED_AFTER) {
          for (const id of stalled.current) {
            if (inFlight.current.size >= ENRICH_PARALLEL) break;
            if (inFlight.current.has(id)) continue;
            inFlight.current.add(id);
            void enrichLeadViaApi(id).finally(() => {
              inFlight.current.delete(id);
              router.refresh();
            });
          }
        }
      }
      router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
