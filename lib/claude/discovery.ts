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
}): Promise<DiscoveryResult> {
  const target = Math.max(1, Math.min(params.count, 100));
  const rulesBlock = discoveryRulesPrompt(params.rules);

  // Seen sets accumulate across batches + against the existing DB.
  const seenNames = new Set(params.existing.names);
  const seenDomains = new Set(params.existing.domains);

  const survivors: DiscoveredLead[] = [];
  let rawCount = 0;
  let failedBatches = 0;

  const batches = Math.ceil(target / CHUNK_SIZE);
  for (let i = 0; i < batches; i += 1) {
    const remaining = target - survivors.length;
    if (remaining <= 0) break;
    const batchSize = Math.min(CHUNK_SIZE, remaining);

    // Tell the model what's already taken so it doesn't waste searches.
    const knownNames = params.existing.displayNames ?? [];
    const exclusionHint =
      knownNames.length > 0
        ? `\nAlready in our system — do NOT return any of these (or close variants): ${knownNames
            .slice(0, 80)
            .join(", ")}.`
        : "";

    const userPrompt = `Find ${batchSize} new speaking-engagement leads.${
      params.focus ? `\n\nOperator focus for this run: "${params.focus}".` : ""
    }${rulesBlock}${exclusionHint}\n\nReturn exactly up to ${batchSize} candidates as the JSON array described in your instructions.`;

    let candidates: DiscoveredLead[] = [];
    try {
      const text = await generateWithWebSearch({
        system: DISCOVERY_SYSTEM,
        userPrompt,
        maxTokens: 16000,
        maxSearches: Math.min(20, Math.max(6, batchSize * 2)),
      });
      const parsed = extractJson<unknown>(text);
      candidates = normalizeCandidates(parsed);
    } catch {
      failedBatches += 1;
      continue; // degrade gracefully — keep whatever other batches produced
    }

    rawCount += candidates.length;

    const filtered = filterDiscoveredLeads(candidates, params.rules);
    for (const c of filtered) {
      const key = normalizeName(c.name);
      const domain = domainFromUrl(c.website) ?? domainFromUrl(c.source_url);
      if (!key) continue;
      if (seenNames.has(key)) continue;
      if (domain && seenDomains.has(domain)) continue;

      seenNames.add(key);
      if (domain) seenDomains.add(domain);
      survivors.push(c);
      if (survivors.length >= target) break;
    }
  }

  // Resolve contacts using ONLY the free inline (Claude) contact captured
  // during the web-search pass — discovery never calls the paid provider
  // (Hunter/Apollo), so a large run costs zero email-lookup credits. The paid
  // provider is invoked later, on-demand, per lead the operator pursues.
  const resolver = getInlineContactResolver();
  const resolved = await mapWithConcurrency(survivors, 4, async (lead) => {
    try {
      const contact = await resolver.resolve({
        name: lead.name,
        website: lead.website,
        source_url: lead.source_url,
        claudeContact: lead.contact ?? null,
      });
      return { ...lead, contact };
    } catch {
      return {
        ...lead,
        contact: {
          name: null,
          role: null,
          email: null,
          contact_status: "needs_lookup" as const,
          source_url: null,
        },
      };
    }
  });

  return { leads: resolved, rawCount, failedBatches };
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
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
