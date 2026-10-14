import Anthropic from "@anthropic-ai/sdk";
import { getEnv, requireEnv } from "@/lib/env";
import { stripCitationTags } from "@/lib/claude/sanitize";
import { addUsage, emptyUsage, recordUsage, type UsageFeature } from "@/lib/claude/usage";

export { stripCitationTags };

// High-powered model — reserved for the work that justifies the cost: org
// research and outreach drafting (both via generateWithWebSearch).
// Opus 5.5 ($4/$20 per MTok) replaced Opus 4.8 ($5/$25) on 2026-10-13: newer
// and 20% cheaper. Its effort default is "medium", so every call sets effort
// explicitly to keep the depth we had on 4.8.
export const CLAUDE_MODEL = "claude-opus-5-5";

// Lower-cost model for light, well-scoped tasks that don't need Opus: site
// content edits, rule parsing, and voice analysis (all via generateText).
export const CLAUDE_MODEL_CHEAP = "claude-sonnet-5";

let _client: Anthropic | null = null;
let _cheapClient: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return _client;
}

/**
 * Client for the lower-cost model. Uses its own key (ANTHROPIC_API_KEY_CHEAP)
 * so its usage/billing is separate; falls back to the main key if that var
 * isn't set, so nothing breaks if only one key is configured.
 */
export function getAnthropicCheap(): Anthropic {
  if (!_cheapClient) {
    const apiKey = getEnv("ANTHROPIC_API_KEY_CHEAP") ?? requireEnv("ANTHROPIC_API_KEY");
    _cheapClient = new Anthropic({ apiKey });
  }
  return _cheapClient;
}

/**
 * Public, factual profile of Jeff Flake used to ground every generation.
 * Kept high-level and verifiable; specifics about a given org always come
 * from live web search, never from this blurb.
 */
export const SPEAKER_PROFILE = `Speaker: Jeff Flake.

Background (public record):
- Former United States Senator from Arizona (2013–2019) and former U.S. Representative (2001–2013).
- Served as U.S. Ambassador to Turkey (2022–2024) — a bipartisan appointment under a Democratic administration despite being a Republican.
- Author of "Conscience of a Conservative" (2017).
- Widely associated with principled, traditional conservatism, fiscal restraint, free trade, immigration reform, and — most prominently — civility, bipartisanship, and pushing back against political polarization.

Strong speaking themes:
- Bridging political divides; civility and good-faith disagreement in a polarized era.
- Principled leadership and political courage; putting conscience over party.
- U.S. foreign policy and diplomacy: NATO, U.S.–Turkey relations, alliances, the practice of statecraft.
- Free markets, trade, and fiscal responsibility.
- The health of American democracy and institutions.
- Faith, character, and public service.

Good-fit venues: universities and colleges (civic engagement, political science, public policy, leadership programs), think tanks and policy institutes, world-affairs councils, corporate and association keynotes, leadership and ethics forums, bipartisan/civility-focused conferences, and faith-and-public-life events.`;

/** Concatenate all text blocks from a Claude message, citation markup removed. */
export function extractText(message: Anthropic.Message): string {
  return stripCitationTags(
    message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n"),
  ).trim();
}

/**
 * Single-shot text generation (no tools) on the lower-cost model. Used for
 * short, well-scoped tasks — site content edits, parsing a tailoring
 * instruction into a structured rule, and voice analysis.
 */
export async function generateText(opts: {
  system: string;
  userPrompt: string;
  maxTokens?: number;
  /** What this call is for; attributed in the api_usage table. */
  feature?: UsageFeature;
}): Promise<string> {
  const client = getAnthropicCheap();
  const totals = emptyUsage();
  const started = Date.now();
  try {
    const message = await client.messages.create({
      model: CLAUDE_MODEL_CHEAP,
      max_tokens: opts.maxTokens ?? 2048,
      thinking: { type: "adaptive" },
      system: opts.system,
      messages: [{ role: "user", content: opts.userPrompt }],
    });
    addUsage(totals, message.usage);
    void recordUsage({
      feature: opts.feature ?? "other",
      model: CLAUDE_MODEL_CHEAP,
      totals,
      durationMs: Date.now() - started,
      ok: true,
    });
    return extractText(message);
  } catch (e) {
    void recordUsage({
      feature: opts.feature ?? "other",
      model: CLAUDE_MODEL_CHEAP,
      totals,
      durationMs: Date.now() - started,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/**
 * Generation with the built-in web-search tool enabled, streamed so long
 * research runs don't hit the SDK's request timeout. Handles `pause_turn`
 * (server tool loop hitting its iteration cap) by resuming.
 *
 * Web-search responses carry citations, which are incompatible with
 * structured outputs (`output_config.format`) — so callers parse JSON from
 * the returned text (see extractJson).
 */
export async function generateWithWebSearch(opts: {
  system: string;
  userPrompt: string;
  maxTokens?: number;
  maxSearches?: number;
  /**
   * Hard deadline for the whole call (including pause_turn resumes). If the
   * stream stalls, this aborts it so the caller sees an error instead of
   * hanging forever. Defaults to 4 minutes.
   */
  timeoutMs?: number;
  /** Use the lower-cost model (faster; fine for lookup-style research). */
  cheap?: boolean;
  /** What this call is for; attributed in the api_usage table. */
  feature?: UsageFeature;
}): Promise<string> {
  const client = opts.cheap ? getAnthropicCheap() : getAnthropic();
  const model = opts.cheap ? CLAUDE_MODEL_CHEAP : CLAUDE_MODEL;
  const totals = emptyUsage();
  const started = Date.now();
  const log = (ok: boolean, error?: string) =>
    void recordUsage({
      feature: opts.feature ?? "other",
      model,
      totals,
      durationMs: Date.now() - started,
      ok,
      error,
    });
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.userPrompt },
  ];

  // Deliberately the basic web-search tool, not the newer
  // `web_search_20260209` "dynamic filtering" variant. That variant routes
  // searches through a code-execution sandbox; in practice the model batched
  // all of its searches into one sandbox call, exhausted `max_uses` at once,
  // then spent minutes retrying before answering in prose instead of JSON.
  // The same contact-research prompt took ~194s and failed on the new tool
  // versus ~36s with valid JSON on this one (measured 2026-10-11).
  const tools = [
    {
      type: "web_search_20250305" as const,
      name: "web_search" as const,
      max_uses: opts.maxSearches ?? 8,
    },
  ];

  // Single deadline shared across pause_turn resumes — a stuck call can never
  // exceed this, so Discover always terminates rather than loading forever.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 240_000);

  let continuations = 0;
  try {
    // Loop only to resume on pause_turn.
    for (;;) {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: opts.maxTokens ?? 16000,
          thinking: { type: "adaptive" },
          // Explicit: Opus 5.5 defaults to "medium"; research and drafting
          // are the calls worth full depth.
          output_config: { effort: "high" },
          system: opts.system,
          tools,
          messages,
        },
        { signal },
      );
      const message = await stream.finalMessage();
      addUsage(totals, message.usage);

      if (message.stop_reason === "pause_turn" && continuations < 5) {
        continuations += 1;
        messages.push({ role: "assistant", content: message.content });
        continue;
      }
      log(true);
      return extractText(message);
    }
  } catch (e) {
    log(false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}
