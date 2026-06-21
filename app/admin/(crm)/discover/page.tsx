import { getActiveRules } from "@/lib/data";
import { describeDiscoveryRules } from "@/lib/claude/rules";
import { DiscoverForm } from "@/components/DiscoverForm";

export const dynamic = "force-dynamic";
// Discovery does long web-search runs. Allow up to 5 min (effective on Vercel
// Pro/Enterprise; Hobby caps lower — see README).
export const maxDuration = 300;

export default async function DiscoverPage() {
  const rules = await getActiveRules();
  const activeRules = describeDiscoveryRules(rules);

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
    </div>
  );
}
