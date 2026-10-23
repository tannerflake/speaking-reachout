import { lookup } from "node:dns/promises";
import { generateWithWebSearch } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import { domainFromUrl } from "@/lib/utils";

/**
 * Guards contact finding against a lead whose saved website is a dead domain.
 * Every Hunter call keys off that domain, so a wrong one (Economic Club of
 * Minnesota was saved as econclubmn.org; the real site is ecomn.org) means
 * every lookup comes back empty and the lead fills up with email-less
 * contacts that can never be sent.
 */

const DEAD_DNS_CODES = new Set(["ENOTFOUND", "ENODATA", "ESERVFAIL"]);

/**
 * true = resolves, false = definitely does not exist, null = could not tell
 * (timeout or other transient DNS error; treat as fine, never "repair" on it).
 */
export async function domainResolves(domain: string): Promise<boolean | null> {
  let unsure = false;
  for (const host of [domain, `www.${domain}`]) {
    try {
      await lookup(host);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!DEAD_DNS_CODES.has(code)) unsure = true;
    }
  }
  return unsure ? null : false;
}

/**
 * Web-search the org's real official website. Returns a URL only when its
 * domain differs from the dead one and actually resolves.
 */
export async function findRealWebsite(lead: {
  name: string;
  location: string | null;
  deadDomain: string;
}): Promise<string | null> {
  let text: string;
  try {
    text = await generateWithWebSearch({
      system:
        "You find the official website of an organization using web search. You return only JSON.",
      userPrompt: `Find the official website of this organization.

Organization: ${lead.name}
Location: ${lead.location ?? "(unknown)"}
The domain we had on file, ${lead.deadDomain}, does not exist (DNS does not resolve), so do not return it.

Rules:
- Only the organization's own site, never a directory, news article, GuideStar/ProPublica, LinkedIn, or social profile.
- If you cannot find it with confidence, return null.

Return ONLY JSON, no prose: { "website": string | null }`,
      maxTokens: 4000,
      maxSearches: 4,
      timeoutMs: 90_000,
      cheap: true,
      feature: "contacts",
    });
  } catch {
    return null;
  }

  let website: string | null = null;
  try {
    website = extractJson<{ website: string | null }>(text).website;
  } catch {
    return null;
  }
  const domain = domainFromUrl(website);
  if (!domain || domain === lead.deadDomain) return null;
  if ((await domainResolves(domain)) !== true) return null;
  return `https://${domain}`;
}
