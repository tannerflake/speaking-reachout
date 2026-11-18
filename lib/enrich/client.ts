import type { EnrichResult } from "@/lib/enrich/pipeline";

// Browser-side helper. Leads prepared at once from one page; matches the
// server queue's concurrency (see lib/enrich/queue.ts).
export const ENRICH_PARALLEL = 4;

/**
 * Find contacts + draft outreach for one lead via POST /api/enrich. A plain
 * fetch rather than a server action, because server actions from one page
 * run one at a time and this needs to run several leads in parallel.
 */
export async function enrichLeadViaApi(leadId: string): Promise<EnrichResult> {
  const failed = (error: string): EnrichResult => ({
    leadId,
    contactsAdded: 0,
    contactsWithEmail: 0,
    draftsCreated: 0,
    hunterUsed: false,
    missingDrafts: 0,
    error,
  });
  try {
    const res = await fetch("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId }),
    });
    if (!res.ok) return failed(`Preparing this lead failed (${res.status}).`);
    return (await res.json()) as EnrichResult;
  } catch (e) {
    return failed(e instanceof Error ? e.message : "Preparing this lead failed.");
  }
}
