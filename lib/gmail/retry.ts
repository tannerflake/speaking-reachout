/**
 * Retry a Gmail API call through rate limiting. Gmail meters "query cost
 * units per minute per user"; a burst of sends plus mailbox checks trips it
 * with a 429 (or a 403 whose reason is a rate/quota limit). Those are
 * transient, so back off exponentially with jitter, honoring
 * Retry-After when Google sends one, and try again.
 *
 * Server errors (5xx) are retried too, except where the caller says a retry
 * could duplicate a side effect (messages.send: a 5xx may have delivered).
 * A 429/403-quota response is a refusal, so retrying a send on it is safe.
 */

const DEFAULT_TRIES = 5;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;

const RATE_LIMIT_REASONS = new Set([
  "ratelimitexceeded",
  "userratelimitexceeded",
  "quotaexceeded",
  "dailylimitexceeded",
  "backenderror",
]);

interface ErrorShape {
  status?: number;
  code?: number | string;
  message?: string;
  errors?: Array<{ reason?: string }>;
  response?: {
    status?: number;
    headers?: unknown;
    data?: { error?: { errors?: Array<{ reason?: string }>; status?: string } };
  };
}

function statusOf(e: ErrorShape): number | null {
  const s = e.response?.status ?? e.status ?? (typeof e.code === "number" ? e.code : Number(e.code));
  return Number.isFinite(s) ? Number(s) : null;
}

function reasonsOf(e: ErrorShape): string[] {
  const list = [...(e.errors ?? []), ...(e.response?.data?.error?.errors ?? [])];
  return list.map((r) => (r.reason ?? "").toLowerCase()).filter(Boolean);
}

/** True for rate-limit / quota refusals: safe to retry, nothing happened. */
export function isGmailRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as ErrorShape;
  const status = statusOf(e);
  if (status === 429) return true;
  const message = (e.message ?? "").toLowerCase();
  const quotaText =
    message.includes("quota exceeded") ||
    message.includes("rate limit exceeded") ||
    message.includes("ratelimitexceeded") ||
    e.response?.data?.error?.status === "RESOURCE_EXHAUSTED";
  if (status === 403) {
    return quotaText || reasonsOf(e).some((r) => RATE_LIMIT_REASONS.has(r));
  }
  return status === null && quotaText;
}

function isServerError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const s = statusOf(err as ErrorShape);
  return s !== null && s >= 500 && s < 600;
}

function retryAfterMs(err: unknown): number | null {
  const headers = (err as ErrorShape)?.response?.headers as
    | { get?: (k: string) => string | null; [k: string]: unknown }
    | undefined;
  if (!headers) return null;
  const raw =
    typeof headers.get === "function"
      ? headers.get("retry-after")
      : (headers["retry-after"] as string | undefined);
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withGmailRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; retryServerErrors?: boolean } = {},
): Promise<T> {
  const tries = Math.max(1, opts.tries ?? DEFAULT_TRIES);
  const retryServerErrors = opts.retryServerErrors ?? true;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      const retryable =
        isGmailRateLimitError(e) || (retryServerErrors && isServerError(e));
      if (!retryable || attempt >= tries) throw e;
      // Equal jitter: half the exponential step, plus a random half.
      const step = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
      const backoff = step / 2 + Math.random() * (step / 2);
      const hinted = retryAfterMs(e);
      const wait = hinted !== null ? Math.min(MAX_RETRY_AFTER_MS, Math.max(hinted, backoff)) : backoff;
      await sleep(wait);
    }
  }
}
