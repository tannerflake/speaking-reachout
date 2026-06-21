import { getEnv } from "@/lib/env";
import { domainFromUrl, looksLikeRealEmail } from "@/lib/utils";
import type { ContactStatus } from "@/lib/types";

export interface ResolvedContact {
  name: string | null;
  role: string | null;
  email: string | null;
  contact_status: ContactStatus;
  source_url: string | null;
}

export interface ResolverInput {
  name: string;
  website: string | null;
  source_url: string | null;
  /** Contact Claude already surfaced during discovery (default path). */
  claudeContact?: {
    name: string | null;
    role: string | null;
    email: string | null;
    contact_status: ContactStatus;
    source_url: string | null;
  } | null;
}

/**
 * Swappable contact-resolution provider. The default (claude) reuses the
 * contact Claude found via web search during discovery. Hunter/Apollo can be
 * dropped in via CONTACT_RESOLVER + their API key.
 *
 * Hard rule across all implementations: NEVER invent an email. If none can be
 * verified, contact_status is "needs_lookup" and email is null.
 */
export interface ContactResolver {
  readonly name: string;
  resolve(input: ResolverInput): Promise<ResolvedContact>;
}

const NEEDS_LOOKUP: ResolvedContact = {
  name: null,
  role: null,
  email: null,
  contact_status: "needs_lookup",
  source_url: null,
};

// --- Claude (default) -------------------------------------------------------
class ClaudeContactResolver implements ContactResolver {
  readonly name = "claude";
  async resolve(input: ResolverInput): Promise<ResolvedContact> {
    const c = input.claudeContact;
    if (!c) return { ...NEEDS_LOOKUP };
    // Trust only real-looking emails; otherwise downgrade to needs_lookup.
    if (c.email && looksLikeRealEmail(c.email)) {
      return {
        name: c.name ?? null,
        role: c.role ?? null,
        email: c.email,
        contact_status:
          c.contact_status === "verified" ? "verified" : "unverified",
        source_url: c.source_url ?? input.source_url,
      };
    }
    return {
      name: c.name ?? null,
      role: c.role ?? null,
      email: null,
      contact_status: "needs_lookup",
      source_url: c.source_url ?? input.source_url,
    };
  }
}

// --- Hunter.io --------------------------------------------------------------
interface HunterEmail {
  value?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  confidence?: number;
}

class HunterContactResolver implements ContactResolver {
  readonly name = "hunter";
  constructor(private apiKey: string) {}

  async resolve(input: ResolverInput): Promise<ResolvedContact> {
    const domain = domainFromUrl(input.website) ?? domainFromUrl(input.source_url);
    if (!domain) return { ...NEEDS_LOOKUP };

    try {
      const url = new URL("https://api.hunter.io/v2/domain-search");
      url.searchParams.set("domain", domain);
      url.searchParams.set("api_key", this.apiKey);
      url.searchParams.set("limit", "10");

      const res = await fetch(url, { method: "GET" });
      if (!res.ok) return { ...NEEDS_LOOKUP };
      const json = (await res.json()) as {
        data?: { emails?: HunterEmail[] };
      };
      const emails = json.data?.emails ?? [];

      // Prefer events/comms/program roles, then highest confidence.
      const ranked = [...emails].sort(
        (a, b) => roleScore(b.position) - roleScore(a.position) ||
          (b.confidence ?? 0) - (a.confidence ?? 0),
      );
      const best = ranked.find((e) => looksLikeRealEmail(e.value));
      if (!best || !best.value) return { ...NEEDS_LOOKUP };

      const fullName = [best.first_name, best.last_name]
        .filter(Boolean)
        .join(" ");
      return {
        name: fullName || null,
        role: best.position ?? null,
        email: best.value,
        // A publicly listed email returned by the provider — treat as verified.
        contact_status: "verified",
        source_url: `https://${domain}`,
      };
    } catch {
      return { ...NEEDS_LOOKUP };
    }
  }
}

// --- Apollo.io --------------------------------------------------------------
class ApolloContactResolver implements ContactResolver {
  readonly name = "apollo";
  constructor(private apiKey: string) {}

  async resolve(input: ResolverInput): Promise<ResolvedContact> {
    const domain = domainFromUrl(input.website) ?? domainFromUrl(input.source_url);
    if (!domain) return { ...NEEDS_LOOKUP };

    try {
      const res = await fetch("https://api.apollo.io/v1/mixed_people/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": this.apiKey,
        },
        body: JSON.stringify({
          q_organization_domains: domain,
          person_titles: [
            "events director",
            "director of events",
            "program director",
            "communications director",
            "speaker",
            "conference",
          ],
          page: 1,
          per_page: 10,
        }),
      });
      if (!res.ok) return { ...NEEDS_LOOKUP };
      const json = (await res.json()) as {
        people?: Array<{
          name?: string;
          title?: string;
          email?: string;
          email_status?: string;
        }>;
      };
      const people = json.people ?? [];
      const best = people.find(
        (p) => p.email_status === "verified" && looksLikeRealEmail(p.email),
      );
      if (!best || !best.email) return { ...NEEDS_LOOKUP };
      return {
        name: best.name ?? null,
        role: best.title ?? null,
        email: best.email,
        contact_status: "verified",
        source_url: `https://${domain}`,
      };
    } catch {
      return { ...NEEDS_LOOKUP };
    }
  }
}

function roleScore(position?: string): number {
  if (!position) return 0;
  const p = position.toLowerCase();
  if (/(event|program|conference|speaker|booking)/.test(p)) return 3;
  if (/(communication|marketing|outreach|public)/.test(p)) return 2;
  if (/(director|chair|coordinator|manager)/.test(p)) return 1;
  return 0;
}

/**
 * Select the env-configured resolver (CONTACT_RESOLVER), falling back to claude.
 * This is the PAID path — it may hit an external API (Hunter/Apollo) that
 * costs credits. Only call it from an explicit, operator-triggered action
 * (e.g. "Find email" on a lead), never in bulk during discovery.
 */
export function getContactResolver(): ContactResolver {
  const choice = (getEnv("CONTACT_RESOLVER") ?? "claude").toLowerCase();
  if (choice === "hunter") {
    const key = getEnv("HUNTER_API_KEY");
    if (key) return new HunterContactResolver(key);
  }
  if (choice === "apollo") {
    const key = getEnv("APOLLO_API_KEY");
    if (key) return new ApolloContactResolver(key);
  }
  return new ClaudeContactResolver();
}

/**
 * Free resolver used during discovery — only reuses the contact Claude already
 * surfaced inline (no extra API cost). Never hits Hunter/Apollo, so a large
 * discovery run consumes zero external email-lookup credits.
 */
export function getInlineContactResolver(): ContactResolver {
  return new ClaudeContactResolver();
}

/** Effective resolver name after accounting for missing keys. */
export function contactResolverName(): "claude" | "hunter" | "apollo" {
  return getContactResolver().name as "claude" | "hunter" | "apollo";
}
