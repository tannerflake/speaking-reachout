import { looksLikeRealEmail } from "@/lib/utils";
import { personKey } from "@/lib/contacts/personKey";
import type { ContactStatus } from "@/lib/types";

/**
 * Thin Hunter.io client shared by the multi-source finder, the single-contact
 * resolver, and the auto-enrich pipeline. Every call here costs credits:
 * domain search = 1 credit, email finder = 1 credit per person.
 */

export interface HunterPerson {
  value?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  confidence?: number;
}

/** Hunter Domain Search: up to 10 public emails at a domain (1 credit). */
export async function hunterDomainPeople(
  domain: string,
  apiKey: string,
): Promise<HunterPerson[]> {
  try {
    const url = new URL("https://api.hunter.io/v2/domain-search");
    url.searchParams.set("domain", domain);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("limit", "10");
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { emails?: HunterPerson[] } };
    return json.data?.emails ?? [];
  } catch {
    return [];
  }
}

export interface HunterFound {
  email: string;
  position: string | null;
  contact_status: ContactStatus;
}

/**
 * Hunter Email Finder: the email for ONE named person at a domain (1 credit).
 * Returns null when Hunter has nothing with a usable confidence score.
 */
export async function hunterFindPerson(
  fullName: string,
  domain: string,
  apiKey: string,
): Promise<HunterFound | null> {
  const key = personKey(fullName).split(" ");
  if (key.length < 2) return null;
  try {
    const url = new URL("https://api.hunter.io/v2/email-finder");
    url.searchParams.set("domain", domain);
    url.searchParams.set("first_name", key[0]);
    url.searchParams.set("last_name", key[key.length - 1]);
    url.searchParams.set("api_key", apiKey);
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        email?: string | null;
        score?: number;
        position?: string | null;
        verification?: { status?: string | null };
      };
    };
    const d = json.data;
    if (!d?.email || !looksLikeRealEmail(d.email) || (d.score ?? 0) < 50) {
      return null;
    }
    return {
      email: d.email.toLowerCase(),
      position: d.position ?? null,
      // Email Finder infers from patterns; only Hunter's "valid" check counts
      // as verified.
      contact_status: d.verification?.status === "valid" ? "verified" : "unverified",
    };
  } catch {
    return null;
  }
}
