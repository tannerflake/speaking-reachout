import { SPEAKER_PROFILE, generateWithWebSearch } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import {
  discoveryRulesPrompt,
  filterDiscoveredLeads,
} from "@/lib/claude/rules";
import { getInlineContactResolver } from "@/lib/contacts/resolver";
import type { DiscoveredLead, LeadType, TailoringRule } from "@/lib/types";
import { domainFromUrl, normalizeName } from "@/lib/utils";

const LEAD_TYPES: LeadType[] = ["event", "institution", "other"];
const CHUNK_SIZE = 12;
// How many web-search calls to run at once. Caps parallelism so a large run
// (up to 100 leads) doesn't fire a huge burst of concurrent API calls.
const MAX_CONCURRENT_BATCHES = 5;
// Upper bound on the number of generation units we split a run into. Small runs
// use one unit per lead (so results trickle in individually); large runs pack
// multiple leads per unit to stay efficient.
const MAX_UNITS = 8;

// When the operator gives no focus, each parallel unit gets a different angle so
// concurrent searches explore distinct slices of the space instead of all
// returning the same obvious venues. Grounded in the speaker's public profile.
const DIVERSIFY_ANGLES = [
  "universities and colleges — civic-engagement, political-science, public-policy, and leadership programs",
  "think tanks, policy institutes, and world-affairs councils",
  "corporate and trade-association keynotes (free markets, trade, fiscal policy)",
  "leadership, ethics, and civility-themed conferences and summits",
  "foreign-policy and diplomacy venues (NATO, U.S.–Turkey relations, statecraft)",
  "faith-and-public-life events and institutions",
  "bipartisan democracy-and-institutions forums and lecture series",
  "regional and state-level civic organizations and city clubs outside the major coastal hubs",
];

const DISCOVERY_SYSTEM = `You find real, currently-existing institutions and events that are plausible PAYING speaking venues for the speaker below. Use the web_search tool to verify every candidate actually exists right now.

${SPEAKER_PROFILE}

You are doing top-of-funnel lead generation. For each candidate return a structured record. Requirements:
- Only return REAL, verifiable organizations/events found via web search. Every candidate MUST include a "source_url" that proves it exists (its official site, a program/events page, a conference site). Discard anything you cannot source.
- Cover both framings: events (conferences, summits, festivals, lecture series) AND institutions (universities, think tanks, world-affairs councils, corporations, associations).
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

export interface DiscoveryResult {
  leads: DiscoveredLead[];
  rawCount: number;
  failedBatches: number;
}

export async function discoverLeads(params: {
  count: number;
  focus?: string;
  rules: TailoringRule[];
  existing: { names: Set<string>; domains: Set<string>; displayNames?: string[] };
  /**
   * Invoked the moment each lead is finalized (deduped + contact-resolved), so
   * callers can persist and stream it immediately instead of waiting for the
   * whole run. Errors thrown here are swallowed so one bad emit can't abort the
   * run.
   */
  onLead?: (lead: DiscoveredLead) => void | Promise<void>;
}): Promise<DiscoveryResult> {
  const target = Math.max(1, Math.min(params.count, 100));
  const rulesBlock = discoveryRulesPrompt(params.rules);

  // Tell the model what's already taken so it doesn't waste searches.
  const knownNames = params.existing.displayNames ?? [];
  const exclusionHint =
    knownNames.length > 0
      ? `\nAlready in our system — do NOT return any of these (or close variants): ${knownNames
          .slice(0, 80)
          .join(", ")}.`
      : "";

  // Split the target into generation units. Each unit is its own web-search
  // call, and they run CONCURRENTLY (capped) — so leads stream back as each
  // unit finishes rather than all arriving at the end. Small runs get one lead
  // per unit (maximum trickle); large runs pack leads per unit for throughput.
  const unitCount = Math.min(target, MAX_UNITS);
  const perUnit = Math.min(CHUNK_SIZE, Math.ceil(target / unitCount));
  const unitSizes: number[] = [];
  for (let left = target; left > 0; left -= perUnit) {
    unitSizes.push(Math.min(perUnit, left));
  }

  // Shared state mutated synchronously across units. JS is single-threaded, so
  // the dedup checks + reservations below form a safe critical section as long
  // as nothing awaits between checking and reserving.
  const seenNames = new Set(params.existing.names);
  const seenDomains = new Set(params.existing.domains);
  const survivors: DiscoveredLead[] = [];
  let reserved = 0; // count of accepted leads, reserved before the async resolve
  let rawCount = 0;
  let failedBatches = 0;

  const resolver = getInlineContactResolver();

  await mapWithConcurrency(unitSizes, MAX_CONCURRENT_BATCHES, async (unitSize, index) => {
    if (reserved >= target) return;

    const angleHint = diversificationHint(index, params.focus);
    const userPrompt = `Find ${unitSize} new speaking-engagement leads.${
      params.focus ? `\n\nOperator focus for this run: "${params.focus}".` : ""
    }${rulesBlock}${exclusionHint}${angleHint}\n\nReturn exactly up to ${unitSize} candidates as the JSON array described in your instructions.`;

    let candidates: DiscoveredLead[];
    try {
      const text = await generateWithWebSearch({
        system: DISCOVERY_SYSTEM,
        userPrompt,
        maxTokens: 16000,
        maxSearches: Math.min(20, Math.max(6, unitSize * 2)),
      });
      candidates = normalizeCandidates(extractJson<unknown>(text));
    } catch {
      failedBatches += 1;
      return; // degrade gracefully — keep whatever other units produced
    }

    rawCount += candidates.length;

    const filtered = filterDiscoveredLeads(candidates, params.rules);
    for (const c of filtered) {
      // --- synchronous critical section: dedup + reserve a slot ---
      if (reserved >= target) break;
      const key = normalizeName(c.name);
      const domain = domainFromUrl(c.website) ?? domainFromUrl(c.source_url);
      if (!key) continue;
      if (seenNames.has(key)) continue;
      if (domain && seenDomains.has(domain)) continue;
      seenNames.add(key);
      if (domain) seenDomains.add(domain);
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
      survivors.push(lead);
      if (params.onLead) {
        try {
          await params.onLead(lead);
        } catch {
          // a failed emit must not abort the run
        }
      }
    }
  });

  return { leads: survivors, rawCount, failedBatches };
}

/**
 * A per-unit nudge so concurrent searches don't all return the same obvious
 * venues. With an operator focus we only ask later units to dig for distinct
 * picks (the focus stays primary); without one, we rotate through angles.
 */
function diversificationHint(index: number, focus?: string): string {
  if (focus) {
    return index === 0
      ? ""
      : `\n\nThis is parallel search #${index + 1}: deliberately return organizations DISTINCT from the most obvious, top-of-mind ones, so parallel searches don't overlap.`;
  }
  const angle = DIVERSIFY_ANGLES[index % DIVERSIFY_ANGLES.length];
  return `\n\nTo diversify this run, lean toward: ${angle}. (Still respect any rules above.)`;
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
