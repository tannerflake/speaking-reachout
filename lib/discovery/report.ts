import type { CandidateOutcome, StopReason } from "@/lib/claude/discovery";

/**
 * Plain-language reporting for a Discover run, shared by the live summary and
 * the "Recent runs" history. Pure functions: safe in client components.
 */

export interface RunCounts {
  requested: number;
  added: number;
  rawCount: number | null;
  duplicates: number | null;
  repeats: number | null;
  ruleFiltered: number | null;
  surplus: number | null;
  saveFailed?: number | null;
  failedBatches: number | null;
  rounds: number | null;
  searches: number | null;
}

const n = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "Found 34 candidates in 3 rounds (9 searches)". */
export function foundLine(c: RunCounts): string {
  const raw = c.rawCount ?? 0;
  const detail = [
    c.rounds ? n(c.rounds, "round") : null,
    c.searches ? n(c.searches, "search", "searches") : null,
  ].filter(Boolean);
  return `The searches proposed ${n(raw, "candidate")}${
    detail.length ? ` over ${detail.join(", ")}` : ""
  }.`;
}

/** Where every candidate that was not added went, one entry per reason. */
export function dropLines(c: RunCounts): string[] {
  const out: string[] = [];
  if (c.duplicates)
    out.push(`${c.duplicates} already in the system (existing lead, past engagement, or a contact's domain)`);
  if (c.repeats) out.push(`${c.repeats} proposed twice within this run`);
  if (c.ruleFiltered) out.push(`${c.ruleFiltered} removed by tailoring rules`);
  if (c.surplus) out.push(`${c.surplus} extra once the requested count was reached`);
  if (c.saveFailed) out.push(`${c.saveFailed} could not be saved`);
  if (c.failedBatches)
    out.push(`${n(c.failedBatches, "search", "searches")} failed or timed out`);
  return out;
}

/** Why the run ended, written for the operator. */
export function stopReasonText(
  reason: StopReason | null,
  requested: number,
  added: number,
): string {
  const short = Math.max(0, requested - added);
  switch (reason) {
    case "target_reached":
      return "Reached the requested number of new leads.";
    case "time_budget":
      return `Stopped ${short} short: ran out of time (a run is limited to about 4 minutes on the server). Run it again to keep going; the next run searches different sectors and regions.`;
    case "max_rounds":
      return `Stopped ${short} short after the maximum number of search rounds.`;
    case "exhausted":
      return `Stopped ${short} short: three search rounds in a row found nothing new. Nearly everything the searches return is already in the system or excluded by the rules; try a different focus.`;
    case "stopped":
      return `Stopped by you${short > 0 ? `, ${short} short of the request` : ""}.`;
    case "errors":
      return `Stopped ${short} short: the searches kept failing.`;
    default:
      return short > 0 ? `Came up ${short} short.` : "";
  }
}

export const OUTCOME_LABEL: Record<CandidateOutcome, string> = {
  added: "Added",
  duplicate: "Duplicate",
  repeat: "Repeat",
  rule: "Rule",
  surplus: "Extra",
  failed: "Not saved",
};
