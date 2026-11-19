import type Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Best-effort usage logging for every Claude call, so spend can be attributed
 * per feature (see supabase/migrations/0025_api_usage.sql). Never throws:
 * a logging failure must not fail the call that produced the result.
 */

export type UsageFeature =
  | "discovery"
  | "outreach"
  | "contacts"
  | "followup"
  | "voice"
  | "rule"
  | "site"
  | "classify"
  | "verify"
  | "other";

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
  requests: number;
}

export function emptyUsage(): UsageTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_search_requests: 0,
    requests: 0,
  };
}

/** Fold one response's `usage` block into a running total. */
export function addUsage(totals: UsageTotals, usage: Anthropic.Usage | null | undefined): void {
  totals.requests += 1;
  if (!usage) return;
  totals.input_tokens += usage.input_tokens ?? 0;
  totals.output_tokens += usage.output_tokens ?? 0;
  totals.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  totals.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  totals.web_search_requests += usage.server_tool_use?.web_search_requests ?? 0;
}

export async function recordUsage(entry: {
  feature: UsageFeature;
  model: string;
  totals: UsageTotals;
  durationMs: number;
  ok: boolean;
  error?: string | null;
  /** anthropic (default) | openai | gemini | hunter | zerobounce | neverbounce. */
  provider?: string;
  /** Provider credits spent (Hunter searches/verifications, verifier checks). */
  credits?: number | null;
  /** Estimated USD, when the provider bills per call rather than per token. */
  costUsd?: number | null;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const base = {
      feature: entry.feature,
      model: entry.model,
      input_tokens: entry.totals.input_tokens,
      output_tokens: entry.totals.output_tokens,
      cache_creation_input_tokens: entry.totals.cache_creation_input_tokens,
      cache_read_input_tokens: entry.totals.cache_read_input_tokens,
      web_search_requests: entry.totals.web_search_requests,
      requests: Math.max(1, entry.totals.requests),
      duration_ms: Math.round(entry.durationMs),
      ok: entry.ok,
      error: entry.error ? entry.error.slice(0, 500) : null,
    };
    let { error } = await admin.from("api_usage").insert({
      ...base,
      provider: entry.provider ?? "anthropic",
      credits: entry.credits ?? null,
      cost_usd: entry.costUsd ?? null,
    });
    if (error && /provider|credits|cost_usd/.test(error.message)) {
      // Migration 0033 not applied: keep the row, without the new columns.
      // The model string carries the provider prefix either way.
      ({ error } = await admin.from("api_usage").insert(base));
    }
    if (error) {
      // Most likely cause: migration 0025 not applied yet. Keep going.
      console.warn(`[api_usage] insert failed: ${error.message}`);
    }
  } catch (e) {
    console.warn(
      `[api_usage] logging skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Log a non-Anthropic call (OpenAI, Gemini, Hunter, an email verifier) in the
 * same api_usage table, so cost audits see every paid provider. The model is
 * stored as "<provider>/<model or endpoint>". Never throws.
 */
export async function recordProviderUsage(entry: {
  provider: string;
  feature: UsageFeature;
  model: string;
  durationMs: number;
  ok: boolean;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  webSearches?: number;
  credits?: number | null;
  costUsd?: number | null;
}): Promise<void> {
  await recordUsage({
    feature: entry.feature,
    model: `${entry.provider}/${entry.model}`,
    totals: {
      ...emptyUsage(),
      input_tokens: entry.inputTokens ?? 0,
      output_tokens: entry.outputTokens ?? 0,
      web_search_requests: entry.webSearches ?? 0,
      requests: 1,
    },
    durationMs: entry.durationMs,
    ok: entry.ok,
    error: entry.error,
    provider: entry.provider,
    credits: entry.credits,
    costUsd: entry.costUsd,
  });
}
