import { getActiveRules, getRecentDiscoveryRuns } from "@/lib/data";
import { describeDiscoveryRules } from "@/lib/claude/rules";
import { DiscoverForm } from "@/components/DiscoverForm";
import { DiscoveryHistory } from "@/components/DiscoveryHistory";
import { DiscoverAutoRefresh } from "@/components/DiscoverAutoRefresh";

export const dynamic = "force-dynamic";
// Server actions on this page (stop a run, re-queue leads) are quick; the
// long work happens in /api/discover and /api/enrich.
export const maxDuration = 300;

export default async function DiscoverPage() {
  const [rules, history] = await Promise.all([
    getActiveRules(),
    getRecentDiscoveryRuns(),
  ]);
  const activeRules = describeDiscoveryRules(rules);
  const searching = history.runs.some((r) => r.status === "running");
  const queueLeads = history.runs.flatMap((r) => r.leads);
  const working = queueLeads.some((l) => l.enrichStatus === "working");
  const pendingIds = queueLeads
    .filter((l) => l.enrichStatus === "pending")
    .map((l) => l.id);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Discover leads</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Generate new, qualified speaking-engagement leads. Results are deduped
          against everything already in the system and land as{" "}
          <span className="font-medium">new</span> leads.
        </p>
      </div>
      <DiscoverForm activeRules={activeRules} />
      <DiscoveryHistory runs={history.runs} available={history.available} />
      <DiscoverAutoRefresh
        active={searching || working || pendingIds.length > 0}
        stalledLeadIds={working ? [] : pendingIds}
      />
    </div>
  );
}
