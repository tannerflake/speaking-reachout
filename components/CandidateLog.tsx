import type { CandidateRecord } from "@/lib/claude/discovery";
import { OUTCOME_LABEL } from "@/lib/discovery/report";

const TONE: Record<CandidateRecord["outcome"], string> = {
  added: "text-emerald-700",
  duplicate: "text-zinc-500",
  repeat: "text-zinc-500",
  rule: "text-amber-700",
  surplus: "text-zinc-500",
  failed: "text-rose-700",
};

/**
 * Every candidate a Discover run's searches proposed and what happened to
 * it: added, already in the system, removed by a rule, and so on.
 */
export function CandidateLog({
  candidates,
}: {
  candidates: CandidateRecord[] | null | undefined;
}) {
  if (!candidates || candidates.length === 0) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-blue-600 hover:underline">
        Show all {candidates.length} candidates and what happened to each
      </summary>
      <ul className="mt-1 max-h-72 divide-y divide-zinc-50 overflow-y-auto rounded border border-zinc-100">
        {candidates.map((c, i) => (
          <li key={i} className="flex items-baseline gap-2 px-2 py-1">
            <span className={`w-16 shrink-0 font-medium ${TONE[c.outcome]}`}>
              {OUTCOME_LABEL[c.outcome]}
            </span>
            <span className="min-w-0 text-zinc-700">
              {c.name}
              <span className="ml-1 text-zinc-400">
                {c.outcome === "added" ? "" : `(${c.reason})`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
