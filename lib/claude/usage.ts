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
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("api_usage").insert({
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
    });
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
