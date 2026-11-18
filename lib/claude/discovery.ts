import { SPEAKER_PROFILE, generateWithWebSearch } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import {
  discoveryAvoidTerms,
  discoveryRejecter,
  discoveryRulesPrompt,
} from "@/lib/claude/rules";
import { getInlineContactResolver } from "@/lib/contacts/resolver";
import type { DiscoveredLead, LeadType, TailoringRule } from "@/lib/types";
import { domainFromUrl, normalizeName, registrableDomain } from "@/lib/utils";

const LEAD_TYPES: LeadType[] = ["event", "institution", "other"];
// How many web-search calls to run at once within a round.
const MAX_CONCURRENT_UNITS = 8;
// Candidates asked of one search. Small enough that a search finishes in
// well under a minute, so several rounds fit in one run.
const MAX_PER_UNIT = 5;
// A run keeps searching in rounds until it has the requested number of NEW
// leads or hits one of these caps.
const MAX_ROUNDS = 8;
// Rounds in a row that add nothing before the run gives up as exhausted.
const MAX_DRY_ROUNDS = 3;
// Default wall-clock budget; the route sets it from its own maxDuration.
const DEFAULT_BUDGET_MS = 235_000;
// Don't start another round with less time than a search typically needs.
const MIN_ROUND_MS = 40_000;
const UNIT_TIMEOUT_MS = 120_000;
// Known org names listed in the prompt so the model doesn't re-propose them.
const MAX_EXCLUSION_NAMES = 700;

// Every search gets its own slice of the space (kind of venue x region x
// event format) so parallel searches, later rounds and later RUNS don't all
// return the same obvious venues. Slices the active rules rule out are
// skipped (see usableAngles).
const VENUE_ANGLES = [
  "universities and colleges: civic-engagement, political-science, public-policy, and leadership programs",
  "presidential libraries, civic history museums, and community lecture series (library and town-hall series)",
  "leadership, ethics, and civility-themed conferences and summits",
  "foreign-policy and diplomacy venues (NATO, U.S.-Turkey relations, statecraft)",
  "faith-and-public-life events and institutions",
  "bipartisan democracy-and-institutions forums and lecture series",
  "city clubs, economic clubs, and regional civic organizations with paid speaker series",
  "independent schools and their all-school speaker programs",
];
const SECTOR_ANGLES = [
  "banking, credit unions, and financial services (state bankers associations, community-bank conferences)",
  "insurance and risk management associations",
  "healthcare, hospital, and pharmaceutical associations",
  "energy, utilities, and electric cooperatives",
  "manufacturing and industrial trade associations",
  "real estate, homebuilding, and construction associations",
  "agriculture, food, and commodity groups",
  "transportation, logistics, trucking, and aviation",
  "technology, telecom, and software industry groups",
  "retail, restaurant, hospitality, and travel associations",
  "law firms, accounting firms, and professional-services partner retreats",
  "chambers of commerce and regional business councils (annual meetings and dinners)",
  "investment, wealth management, and private equity client conferences",
  "defense, aerospace, and government-contracting industry groups",
  "mining, oil and gas, and natural-resources associations",
  "corporate leadership-development programs and executive education",
];
const REGION_ANGLES = [
  "the U.S. Midwest",
  "the U.S. Southeast",
  "Texas and the south-central U.S.",
  "the U.S. Northeast and New England",
  "the Mountain West and Great Plains",
  "the Pacific coast states",
  "the Mid-Atlantic and Washington, D.C. area",
  "national organizations headquartered anywhere in the U.S.",
  "Canada and other English-speaking countries",
];
const FORMAT_ANGLES = [
  "annual conferences and conventions that book a paid keynote",
  "executive leadership summits and retreats",
  "economic-outlook and public-policy luncheons or dinners",
  "government-affairs conferences and legislative fly-ins",
  "annual member meetings and galas with a featured speaker",
  "ongoing distinguished-speaker series",
  "board, partner, and client events hosted by companies",
];

const DISCOVERY_SYSTEM = `You find real, currently-existing institutions and events that are plausible PAYING speaking venues for the speaker below. Use the web_search tool to verify every candidate actually exists right now.

${SPEAKER_PROFILE}

You are doing top-of-funnel lead generation. For each candidate return a structured record. Requirements:
- Only return REAL, verifiable organizations/events found via web search. Every candidate MUST include a "source_url" that proves it exists (its official site, a program/events page, a conference site). Discard anything you cannot source.
- If the operator gives a focus, it decides what kinds of venues to return: return only venues that match it, and ignore the venue lists in the speaker profile. Without a focus, cover both framings: events (conferences, summits, festivals, lecture series) AND institutions (universities, corporations, associations).
- NEVER return think tanks or policy institutes (organizations whose main work is policy research and advocacy, e.g. R Street, Niskanen, Brookings, Heritage, AEI). They do not pay speakers. This holds even if the operator focus seems to invite them.
- For each, write a specific "fit_rationale": why THIS venue/audience is a strong match for this speaker.
- Provide 2-4 "suggested_topics" tailored to that audience.
- Best-effort contact: if the org's official site lists a relevant contact (events director, program chair, communications/booking contact) with a PUBLIC email, include it. NEVER invent or pattern-guess an email (no "firstname.lastname@" guessing). If you cannot find a real public email, set email to null and contact_status to "needs_lookup". Use "verified" only when the email comes from an official source page; "unverified" if reasonably inferred from a public source but not certain.

Output format — return ONLY a JSON array (no prose, no markdown fences). Each element:
{
  "name": string,
  "type": "event" | "institution" | "other",
  "description": string,
  "location_country": string,
  "location_region": string | null,
  "website": string | null,
  "source_url": string,
  "fit_rationale": string,
  "suggested_topics": string[],
  "contact": {
    "name": string | null,
    "role": string | null,
    "email": string | null,
    "contact_status": "verified" | "unverified" | "needs_lookup",
    "source_url": string | null
  } | null
}`;

export type CandidateOutcome =
  | "added"
  | "duplicate"
  | "repeat"
  | "rule"
  | "surplus"
  | "failed";

/** What happened to one candidate the models proposed. */
export interface CandidateRecord {
  name: string;
  outcome: CandidateOutcome;
  reason: string;
  round: number;
}

export type StopReason =
  | "target_reached"
  | "time_budget"
  | "max_rounds"
  | "exhausted"
  | "stopped"
  | "errors";

export interface DiscoveryProgress {
  /** Rounds started so far. */
  rounds: number;
  /** Web-search calls made. */
  searches: number;
  /** Candidates the models proposed. */
  rawCount: number;
  added: number;
  /** Dropped: the org is already in the system. */
  duplicates: number;
  /** Dropped: proposed more than once within this run. */
  repeats: number;
  /** Dropped by tailoring rules (incl. the think-tank ban). */
  ruleFiltered: number;
  /** Valid, but the requested count was already reached. */
  surplus: number;
  /** Passed every check but could not be saved. */
  saveFailed: number;
  failedBatches: number;
}

export interface DiscoveryResult extends DiscoveryProgress {
  leads: DiscoveredLead[];
  stopReason: StopReason;
  candidates: CandidateRecord[];
  /** Distinct search errors (timeouts, API failures), for the run report. */
  errors: string[];
}

export async function discoverLeads(params: {
  count: number;
  focus?: string;
  rules: TailoringRule[];
  existing: { names: Set<string>; domains: Set<string>; displayNames?: string[] };
  /** Wall-clock budget for the whole run. */
  budgetMs?: number;
  /**
   * Invoked the moment each lead is finalized (deduped + contact-resolved), so
   * callers can persist and stream it immediately instead of waiting for the
   * whole run. Return false (or throw) when the lead could not be saved; it
   * then doesn't count toward the target and the run keeps looking.
   */
  onLead?: (lead: DiscoveredLead) => boolean | void | Promise<boolean | void>;
  /** Called whenever the counters change. */
  onProgress?: (progress: DiscoveryProgress) => void | Promise<void>;
  /** Polled during the run; return true to stop early (operator pressed Stop). */
  shouldStop?: () => boolean | Promise<boolean>;
}): Promise<DiscoveryResult> {
  const target = Math.max(1, Math.min(params.count, 100));
  const deadline = Date.now() + (params.budgetMs ?? DEFAULT_BUDGET_MS);
  const rulesBlock = discoveryRulesPrompt(params.rules, {
    focused: Boolean(params.focus),
  });
  const rejectedByRule = discoveryRejecter(params.rules);
  const angles = usableAngles(params.rules, Boolean(params.focus));
  // Random starting slice, so a repeat run doesn't replay the last run's
  // searches against a system that already holds their results.
  const offset = Math.floor(Math.random() * 10_000);

  // Shared state mutated synchronously across units. JS is single-threaded, so
  // the dedup checks + reservations below form a safe critical section as long
  // as nothing awaits between checking and reserving.
  const runNames = new Set<string>();
  const runDomains = new Set<string>();
  const proposedNames: string[] = [];
  const survivors: DiscoveredLead[] = [];
  const candidates: CandidateRecord[] = [];
  const errors: string[] = [];
  const p: DiscoveryProgress = {
    rounds: 0,
    searches: 0,
    rawCount: 0,
    added: 0,
    duplicates: 0,
    repeats: 0,
    ruleFiltered: 0,
    surplus: 0,
    saveFailed: 0,
    failedBatches: 0,
  };
  let reserved = 0; // accepted leads, reserved before the async resolve/save
  let unitsStarted = 0;
  let stopped = false;

  const resolver = getInlineContactResolver();
  const progress = async () => {
    try {
      await params.onProgress?.({ ...p });
    } catch {
      // progress reporting must never abort the run
    }
  };
  const record = (c: DiscoveredLead, outcome: CandidateOutcome, reason: string) => {
    candidates.push({ name: c.name, outcome, reason, round: p.rounds });
  };
  const checkStop = async () => {
    if (stopped) return true;
    try {
      if (await params.shouldStop?.()) stopped = true;
    } catch {
      // can't read the stop flag: keep going
    }
    return stopped;
  };

  async function runUnit(unitSize: number, unitIndex: number, round: number, abort: AbortController) {
    if (reserved >= target || abort.signal.aborted) return;

    // Tell the model what's already taken so it doesn't waste searches:
    // everything in the system plus everything proposed earlier in this run.
    const known = [
      ...proposedNames,
      ...(params.existing.displayNames ?? []),
    ].slice(0, MAX_EXCLUSION_NAMES);
    const exclusionHint =
      known.length > 0
        ? `\nAlready in our system or already proposed. Do NOT return any of these (or close variants, parent organizations, or their sub-units): ${known.join("; ")}.`
        : "";
    const userPrompt = `Find ${unitSize} new speaking-engagement leads.${
      params.focus
        ? `\n\nOperator focus for this run: "${params.focus}". Return only venues that match this focus.`
        : ""
    }${rulesBlock}${exclusionHint}${sliceHint(angles, offset + unitIndex, round, params.focus)}\n\nReturn exactly up to ${unitSize} candidates as the JSON array described in your instructions.`;

    p.searches += 1;
    let found: DiscoveredLead[];
    try {
      const text = await generateWithWebSearch({
        system: DISCOVERY_SYSTEM,
        userPrompt,
        maxTokens: 16000,
        maxSearches: Math.min(20, Math.max(6, unitSize * 2)),
        timeoutMs: Math.max(15_000, Math.min(UNIT_TIMEOUT_MS, deadline - Date.now() - 5_000)),
        signal: abort.signal,
        feature: "discovery",
      });
      found = normalizeCandidates(extractJson<unknown>(text));
    } catch (e) {
      // Cancelled on purpose (target reached / Stop): not a failure.
      if (abort.signal.aborted) return;
      p.failedBatches += 1;
      const raw = e instanceof Error ? e.message : String(e);
      const msg = /timeout|aborted/i.test(raw)
        ? "a search timed out"
        : raw.slice(0, 160);
      if (!errors.includes(msg) && errors.length < 5) errors.push(msg);
      await progress();
      return; // degrade gracefully: keep whatever other units produced
    }

    p.rawCount += found.length;

    for (const c of found) {
      proposedNames.push(c.name);
      // --- synchronous critical section: classify + reserve a slot ---
      const key = normalizeName(c.name);
      const domain = domainFromUrl(c.website) ?? domainFromUrl(c.source_url);
      const reg = registrableDomain(domain);
      const ruleReason = isThinkTank(c)
        ? "think tanks don't pay speakers"
        : rejectedByRule(c);
      if (!key) {
        p.ruleFiltered += 1;
        record(c, "rule", "no usable organization name");
        continue;
      }
      if (ruleReason) {
        p.ruleFiltered += 1;
        record(c, "rule", ruleReason);
        continue;
      }
      if (params.existing.names.has(key)) {
        p.duplicates += 1;
        record(c, "duplicate", "already in the system (same name)");
        continue;
      }
      const existingDomain = [domain, reg].find(
        (d) => d && params.existing.domains.has(d),
      );
      if (existingDomain) {
        p.duplicates += 1;
        record(c, "duplicate", `already in the system (same domain: ${existingDomain})`);
        continue;
      }
      if (
        runNames.has(key) ||
        (domain && runDomains.has(domain)) ||
        (reg && runDomains.has(reg))
      ) {
        p.repeats += 1;
        record(c, "repeat", "proposed more than once in this run");
        continue;
      }
      if (reserved >= target) {
        p.surplus += 1;
        record(c, "surplus", "valid, but the requested count was already reached");
        continue;
      }
      runNames.add(key);
      if (domain) runDomains.add(domain);
      if (reg) runDomains.add(reg);
      reserved += 1;
      // --- end critical section ---

      // Resolve the contact from what Claude already found inline (free, no
      // paid provider) and emit immediately so the caller can stream it.
      let contact: DiscoveredLead["contact"];
      try {
        contact = await resolver.resolve({
          name: c.name,
          website: c.website,
          source_url: c.source_url,
          claudeContact: c.contact ?? null,
        });
      } catch {
        contact = {
          name: null,
          role: null,
          email: null,
          contact_status: "needs_lookup",
          source_url: null,
        };
      }
      const lead = { ...c, contact };
      let saved = true;
      if (params.onLead) {
        try {
          saved = (await params.onLead(lead)) !== false;
        } catch {
          saved = false;
        }
      }
      if (saved) {
        survivors.push(lead);
        p.added += 1;
        record(c, "added", "added as a new lead");
        // Enough leads: cancel the searches still in flight instead of
        // paying for candidates that would only be thrown away.
        if (p.added >= target) abort.abort();
      } else {
        // Free the slot so the run keeps looking for a replacement.
        reserved -= 1;
        p.saveFailed += 1;
        record(c, "failed", "could not be saved to the database");
      }
    }
    await progress();
  }

  let stopReason: StopReason | null = null;
  let dryRounds = 0;
  let failedRounds = 0;
  while (!stopReason) {
    if (p.added >= target) stopReason = "target_reached";
    else if (await checkStop()) stopReason = "stopped";
    else if (failedRounds >= 2) stopReason = "errors";
    else if (dryRounds >= MAX_DRY_ROUNDS) stopReason = "exhausted";
    else if (p.rounds >= MAX_ROUNDS) stopReason = "max_rounds";
    else if (deadline - Date.now() < MIN_ROUND_MS) stopReason = "time_budget";
    if (stopReason) break;

    // Size the round from the yield so far: when most candidates turn out to
    // be duplicates, ask for proportionally more to still land the target.
    const need = target - reserved;
    const yieldSoFar =
      p.rawCount > 0 ? Math.min(1, Math.max(0.15, p.added / p.rawCount)) : 0.5;
    const wanted = Math.ceil(need / yieldSoFar) + 1;
    const units = Math.max(
      1,
      Math.min(MAX_CONCURRENT_UNITS, Math.ceil(wanted / MAX_PER_UNIT)),
    );
    const perUnit = Math.max(2, Math.min(MAX_PER_UNIT, Math.ceil(wanted / units)));

    const round = p.rounds;
    p.rounds += 1;
    const addedBefore = p.added;
    const failedBefore = p.failedBatches;
    const abort = new AbortController();
    // Stop reaches searches that are already in flight.
    const stopPoll = setInterval(() => {
      void checkStop().then((s) => s && abort.abort());
    }, 4_000);
    try {
      await Promise.all(
        Array.from({ length: units }, () => {
          const unitIndex = unitsStarted;
          unitsStarted += 1;
          return runUnit(perUnit, unitIndex, round, abort);
        }),
      );
    } finally {
      clearInterval(stopPoll);
    }
    await progress();

    dryRounds = p.added > addedBefore ? 0 : dryRounds + 1;
    failedRounds =
      p.failedBatches - failedBefore >= units ? failedRounds + 1 : 0;
  }

  return { ...p, leads: survivors, stopReason, candidates, errors };
}

/** Does this search angle point at something the active rules exclude? */
function conflictsWithRules(angle: string, avoid: string[]): boolean {
  const hay = angle.toLowerCase();
  return avoid.some((term) => {
    // Crude stem so "university" also catches "universities".
    const stem = term.replace(/(ies|es|s|y)$/, "");
    return stem.length >= 4 && hay.includes(stem);
  });
}

function usableAngles(rules: TailoringRule[], focused: boolean) {
  const avoid = discoveryAvoidTerms(rules);
  const keep = (list: string[]) => {
    const ok = list.filter((a) => !conflictsWithRules(a, avoid));
    return ok.length > 0 ? ok : list;
  };
  // A focused run already names its kind of venue; only the industry sectors
  // are offered as an optional lean.
  const venues = focused
    ? keep(SECTOR_ANGLES)
    : keep([...SECTOR_ANGLES, ...VENUE_ANGLES]);
  return {
    venues,
    regions: keep(REGION_ANGLES),
    formats: keep(FORMAT_ANGLES),
  };
}

/**
 * The slice of the space one search should cover. `n` is the search's
 * sequence number within the run (plus a random per-run offset); the three
 * lists have different lengths, so successive searches walk through distinct
 * venue x region x format combinations.
 */
function sliceHint(
  angles: ReturnType<typeof usableAngles>,
  n: number,
  round: number,
  focus?: string,
): string {
  const venue = angles.venues[n % angles.venues.length];
  const region = angles.regions[n % angles.regions.length];
  const format = angles.formats[n % angles.formats.length];
  const deeper =
    round > 0
      ? " Earlier searches in this run mostly returned organizations we already have, so skip the famous, top-of-the-results names and dig for smaller, regional, state-level, or niche organizations."
      : "";
  if (focus) {
    return `\n\nSearch slice for this query, so parallel searches don't overlap (apply it only where it is compatible with the operator focus): region: ${region}; event format: ${format}; if the focus spans industries, lean toward ${venue}.${deeper}`;
  }
  return `\n\nSearch slice for this query, so parallel searches don't overlap: ${venue}; region: ${region}; event format: ${format}. (Still respect any rules above.)${deeper}`;
}

/** Think tanks don't pay speakers, so they're dropped even if the model returns one. */
function isThinkTank(c: DiscoveredLead): boolean {
  const hay = `${c.name} ${c.description}`.toLowerCase();
  return /think[\s-]?tank/.test(hay);
}

function normalizeCandidates(parsed: unknown): DiscoveredLead[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { leads?: unknown[] })?.leads)
      ? (parsed as { leads: unknown[] }).leads
      : [];

  const out: DiscoveredLead[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const source_url = typeof o.source_url === "string" ? o.source_url.trim() : "";
    // Spec: discard any lead without a source.
    if (!name || !source_url) continue;

    const type = LEAD_TYPES.includes(o.type as LeadType)
      ? (o.type as LeadType)
      : "other";

    const topics = Array.isArray(o.suggested_topics)
      ? (o.suggested_topics.filter((t) => typeof t === "string") as string[])
      : [];

    let contact: DiscoveredLead["contact"];
    if (o.contact && typeof o.contact === "object") {
      const c = o.contact as Record<string, unknown>;
      const cs = c.contact_status;
      contact = {
        name: typeof c.name === "string" ? c.name : null,
        role: typeof c.role === "string" ? c.role : null,
        email: typeof c.email === "string" ? c.email : null,
        contact_status:
          cs === "verified" || cs === "unverified" ? cs : "needs_lookup",
        source_url: typeof c.source_url === "string" ? c.source_url : null,
      };
    }

    out.push({
      name,
      type,
      description: typeof o.description === "string" ? o.description : "",
      location_country:
        typeof o.location_country === "string" ? o.location_country : "",
      location_region:
        typeof o.location_region === "string" ? o.location_region : null,
      website: typeof o.website === "string" ? o.website : null,
      source_url,
      fit_rationale:
        typeof o.fit_rationale === "string" ? o.fit_rationale : "",
      suggested_topics: topics,
      contact,
    });
  }
  return out;
}
