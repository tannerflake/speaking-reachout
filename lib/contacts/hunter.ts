import { looksLikeRealEmail } from "@/lib/utils";
import { personKey } from "@/lib/contacts/personKey";
import { recordProviderUsage } from "@/lib/claude/usage";
import type { ContactStatus } from "@/lib/types";

/**
 * Thin Hunter.io client shared by the multi-source finder, the single-contact
 * resolver, and the auto-enrich pipeline. Every call here costs credits:
 * domain search = 1 credit, email finder = 1 credit per person. Every call is
 * logged in api_usage (provider "hunter").
 *
 * Quota, auth and rate-limit failures throw HunterApiError instead of looking
 * like "Hunter found nobody": callers report them in logs and run summaries.
 * Other failures (timeouts, 5xx) still return empty and are logged.
 */

export type HunterErrorKind = "quota" | "auth" | "rate_limit" | "http";

export class HunterApiError extends Error {
  constructor(
    readonly kind: HunterErrorKind,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HunterApiError";
  }
}

/** Errors that block every later Hunter call too (not worth retrying now). */
export function isBlockingHunterError(e: unknown): e is HunterApiError {
  return e instanceof HunterApiError && e.kind !== "http";
}

export function hunterErrorText(e: HunterApiError): string {
  switch (e.kind) {
    case "quota":
      return `Hunter is out of searches (${e.message}). Contact emails will not be found until the plan resets or is upgraded.`;
    case "auth":
      return `Hunter rejected the API key (${e.message}). Check HUNTER_API_KEY.`;
    case "rate_limit":
      return `Hunter rate limit hit (${e.message}); try again in a minute.`;
    default:
      return `Hunter error: ${e.message}`;
  }
}

async function hunterError(res: Response): Promise<HunterApiError> {
  let detail = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { errors?: Array<{ id?: string; details?: string }> };
    const first = j.errors?.[0];
    if (first) detail = [first.id, first.details].filter(Boolean).join(": ") || detail;
  } catch {
    // body not JSON
  }
  // Hunter: 401 = bad key, 429 = plan usage limit reached, 403 = per-second
  // rate limit. 402 / "usage" wording treated as quota for safety.
  const kind: HunterErrorKind =
    res.status === 401
      ? "auth"
      : res.status === 403
        ? "rate_limit"
        : res.status === 429 || res.status === 402 || /usage|quota|limit_reached/i.test(detail)
          ? "quota"
          : "http";
  return new HunterApiError(kind, detail, res.status);
}

/** Fetch a Hunter endpoint, log it, and throw HunterApiError on a non-2xx. */
async function hunterGet<T>(endpoint: string, url: URL, credits: number): Promise<T> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void recordProviderUsage({
      provider: "hunter",
      feature: "contacts",
      model: endpoint,
      durationMs: Date.now() - started,
      ok: false,
      error: msg,
      credits: 0,
    });
    throw new HunterApiError("http", msg, 0);
  }
  if (!res.ok) {
    const err = await hunterError(res);
    console.error(`[hunter] ${endpoint} failed (${err.kind}): ${err.message}`);
    void recordProviderUsage({
      provider: "hunter",
      feature: "contacts",
      model: endpoint,
      durationMs: Date.now() - started,
      ok: false,
      error: `${err.kind}: ${err.message}`,
      credits: 0,
    });
    throw err;
  }
  const json = (await res.json()) as T;
  void recordProviderUsage({
    provider: "hunter",
    feature: "contacts",
    model: endpoint,
    durationMs: Date.now() - started,
    ok: true,
    credits,
  });
  return json;
}

export interface HunterPerson {
  value?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  confidence?: number;
  /** Hunter's own mailbox check, when it has run one for this address. */
  verification?: { status?: string | null; date?: string | null } | null;
}

/**
 * What a Hunter result really tells us. A domain search lists addresses Hunter
 * has SEEN somewhere, not addresses it has checked; only its "valid"
 * verification counts as verified. Everything else (accept_all, unknown, no
 * check at all) is unverified and held until verified. "invalid" is dropped.
 */
export function hunterContactStatus(p: HunterPerson): ContactStatus | null {
  const s = (p.verification?.status ?? "").toLowerCase();
  if (s === "invalid") return null;
  return s === "valid" ? "verified" : "unverified";
}

/**
 * Hunter Domain Search: up to 10 public emails at a domain (1 credit).
 * Throws HunterApiError on quota/auth/rate-limit; [] on other failures.
 */
export async function hunterDomainPeople(
  domain: string,
  apiKey: string,
): Promise<HunterPerson[]> {
  const url = new URL("https://api.hunter.io/v2/domain-search");
  url.searchParams.set("domain", domain);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("limit", "10");
  try {
    const json = await hunterGet<{ data?: { emails?: HunterPerson[] } }>(
      "domain-search",
      url,
      1,
    );
    return json.data?.emails ?? [];
  } catch (e) {
    if (isBlockingHunterError(e)) throw e;
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
 * Throws HunterApiError on quota/auth/rate-limit.
 */
export async function hunterFindPerson(
  fullName: string,
  domain: string,
  apiKey: string,
): Promise<HunterFound | null> {
  const key = personKey(fullName).split(" ");
  if (key.length < 2) return null;
  const url = new URL("https://api.hunter.io/v2/email-finder");
  url.searchParams.set("domain", domain);
  url.searchParams.set("first_name", key[0]);
  url.searchParams.set("last_name", key[key.length - 1]);
  url.searchParams.set("api_key", apiKey);
  let json: {
    data?: {
      email?: string | null;
      score?: number;
      position?: string | null;
      verification?: { status?: string | null };
    };
  };
  try {
    json = await hunterGet("email-finder", url, 1);
  } catch (e) {
    if (isBlockingHunterError(e)) throw e;
    return null;
  }
  const d = json.data;
  if (!d?.email || !looksLikeRealEmail(d.email) || (d.score ?? 0) < 50) {
    return null;
  }
  if ((d.verification?.status ?? "").toLowerCase() === "invalid") return null;
  return {
    email: d.email.toLowerCase(),
    position: d.position ?? null,
    // Email Finder infers from patterns; only Hunter's "valid" check counts
    // as verified.
    contact_status: d.verification?.status === "valid" ? "verified" : "unverified",
  };
}

export interface HunterAccount {
  searchesUsed: number;
  searchesAvailable: number;
  searchesLeft: number;
  verificationsUsed: number;
  verificationsAvailable: number;
  resetDate: string | null;
  planName: string | null;
}

/**
 * Hunter Account endpoint (free, no credits): searches used/available on the
 * current plan. Throws HunterApiError when the key is rejected.
 */
export async function hunterAccount(apiKey: string): Promise<HunterAccount> {
  const url = new URL("https://api.hunter.io/v2/account");
  url.searchParams.set("api_key", apiKey);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  if (!res.ok) throw await hunterError(res);
  const j = (await res.json()) as {
    data?: {
      plan_name?: string;
      reset_date?: string;
      requests?: {
        searches?: { used?: number; available?: number; remaining?: number };
        verifications?: { used?: number; available?: number };
      };
    };
  };
  const s = j.data?.requests?.searches ?? {};
  const v = j.data?.requests?.verifications ?? {};
  const used = s.used ?? 0;
  const available = s.available ?? 0;
  return {
    searchesUsed: used,
    searchesAvailable: available,
    searchesLeft: Math.max(0, s.remaining ?? available - used),
    verificationsUsed: v.used ?? 0,
    verificationsAvailable: v.available ?? 0,
    resetDate: j.data?.reset_date ?? null,
    planName: j.data?.plan_name ?? null,
  };
}
