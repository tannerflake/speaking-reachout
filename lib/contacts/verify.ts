import { getEnv } from "@/lib/env";
import { recordProviderUsage } from "@/lib/claude/usage";

/**
 * Pluggable mailbox verification, run before an unverified address is allowed
 * into the send queue. Unverified addresses bounce about 27% of the time
 * (verified: 3.3%), and every bounce costs sender reputation, so with no
 * verifier configured those addresses are simply held.
 *
 * Configure ONE of:
 *   EMAIL_VERIFIER=zerobounce   + ZEROBOUNCE_API_KEY
 *   EMAIL_VERIFIER=neverbounce  + NEVERBOUNCE_API_KEY
 *   EMAIL_VERIFIER=hunter       (uses HUNTER_API_KEY; costs Hunter credits)
 * Setting ZEROBOUNCE_API_KEY or NEVERBOUNCE_API_KEY alone also selects it.
 *
 * A definite "valid" lets an address through. A catch-all / accept-all result
 * ("risky") is sendable only when the address is printed on the named page it
 * was sourced from (see lib/contacts/deliverability.ts); "unknown" stays held.
 *
 * Every check is logged in api_usage (feature "verify") with its credits and
 * an estimated cost: ZEROBOUNCE_COST_PER_CHECK / NEVERBOUNCE_COST_PER_CHECK
 * (USD, default 0.01 / 0.008, list prices for small packs; set your plan's
 * rate). ZeroBounce does not charge for "unknown" results.
 */

export type VerifyOutcome = "valid" | "invalid" | "risky" | "unknown";

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** Provider's own status string, for the activity log. */
  detail: string;
  provider: string;
  /** Credits the check consumed (0 when the provider doesn't bill it). */
  credits?: number;
}

interface Verifier {
  name: string;
  verify(email: string): Promise<VerifyResult>;
}

class ZeroBounce implements Verifier {
  readonly name = "zerobounce";
  constructor(private key: string) {}
  async verify(email: string): Promise<VerifyResult> {
    const url = new URL("https://api.zerobounce.net/v2/validate");
    url.searchParams.set("api_key", this.key);
    url.searchParams.set("email", email);
    url.searchParams.set("ip_address", "");
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`ZeroBounce HTTP ${res.status}`);
    const j = (await res.json()) as { status?: string; sub_status?: string; error?: string };
    if (j.error) throw new Error(`ZeroBounce: ${j.error}`);
    const status = (j.status ?? "").toLowerCase();
    const detail = [status, j.sub_status].filter(Boolean).join("/");
    const outcome: VerifyOutcome =
      status === "valid"
        ? "valid"
        : status === "invalid" || status === "spamtrap" || status === "abuse" || status === "do_not_mail"
          ? "invalid"
          : status === "catch-all"
            ? "risky"
            : "unknown";
    // ZeroBounce refunds "unknown" results.
    return { outcome, detail, provider: this.name, credits: status === "unknown" ? 0 : 1 };
  }
}

class NeverBounce implements Verifier {
  readonly name = "neverbounce";
  constructor(private key: string) {}
  async verify(email: string): Promise<VerifyResult> {
    const url = new URL("https://api.neverbounce.com/v4/single/check");
    url.searchParams.set("key", this.key);
    url.searchParams.set("email", email);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`NeverBounce HTTP ${res.status}`);
    const j = (await res.json()) as { status?: string; result?: string; message?: string };
    if (j.status && j.status !== "success") throw new Error(`NeverBounce: ${j.message ?? j.status}`);
    const r = (j.result ?? "").toLowerCase();
    const outcome: VerifyOutcome =
      r === "valid" ? "valid" : r === "invalid" || r === "disposable" ? "invalid" : r === "catchall" ? "risky" : "unknown";
    return { outcome, detail: r, provider: this.name };
  }
}

class HunterVerifier implements Verifier {
  readonly name = "hunter";
  constructor(private key: string) {}
  async verify(email: string): Promise<VerifyResult> {
    const url = new URL("https://api.hunter.io/v2/email-verifier");
    url.searchParams.set("email", email);
    url.searchParams.set("api_key", this.key);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    // 202: verification still running on Hunter's side; try again later.
    if (res.status === 202) return { outcome: "unknown", detail: "pending", provider: this.name };
    if (!res.ok) throw new Error(`Hunter verifier HTTP ${res.status}`);
    const j = (await res.json()) as { data?: { status?: string; result?: string } };
    const s = (j.data?.status ?? "").toLowerCase();
    const outcome: VerifyOutcome =
      s === "valid" ? "valid" : s === "invalid" ? "invalid" : s === "accept_all" ? "risky" : "unknown";
    return { outcome, detail: s, provider: this.name };
  }
}

export function getEmailVerifier(): Verifier | null {
  const choice = (getEnv("EMAIL_VERIFIER") ?? "").toLowerCase();
  const zb = getEnv("ZEROBOUNCE_API_KEY");
  const nb = getEnv("NEVERBOUNCE_API_KEY");
  if (choice === "zerobounce" && zb) return new ZeroBounce(zb);
  if (choice === "neverbounce" && nb) return new NeverBounce(nb);
  if (choice === "hunter") {
    const key = getEnv("HUNTER_API_KEY");
    if (key) return new HunterVerifier(key);
  }
  if (choice === "none") return null;
  if (!choice) {
    if (zb) return new ZeroBounce(zb);
    if (nb) return new NeverBounce(nb);
  }
  return null;
}

export function emailVerifierName(): string | null {
  return getEmailVerifier()?.name ?? null;
}

function costPerCheck(provider: string): number | null {
  const env =
    provider === "zerobounce"
      ? getEnv("ZEROBOUNCE_COST_PER_CHECK")
      : provider === "neverbounce"
        ? getEnv("NEVERBOUNCE_COST_PER_CHECK")
        : undefined;
  const n = Number(env);
  if (env && Number.isFinite(n) && n >= 0) return n;
  if (provider === "zerobounce") return 0.01;
  if (provider === "neverbounce") return 0.008;
  return null; // Hunter: plan credits, no per-check price
}

export async function verifyEmailAddress(email: string): Promise<VerifyResult | null> {
  const v = getEmailVerifier();
  if (!v) return null;
  const started = Date.now();
  try {
    const result = await v.verify(email.trim().toLowerCase());
    const credits = result.credits ?? (result.detail === "pending" ? 0 : 1);
    const unit = costPerCheck(v.name);
    void recordProviderUsage({
      provider: v.name,
      feature: "verify",
      model: "single-check",
      durationMs: Date.now() - started,
      ok: true,
      credits,
      costUsd: unit === null ? null : Math.round(unit * credits * 10_000) / 10_000,
    });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[verify] ${v.name} check failed: ${msg}`);
    void recordProviderUsage({
      provider: v.name,
      feature: "verify",
      model: "single-check",
      durationMs: Date.now() - started,
      ok: false,
      error: msg,
      credits: 0,
      costUsd: 0,
    });
    throw e;
  }
}
