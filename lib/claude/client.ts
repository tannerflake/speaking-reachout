import Anthropic from "@anthropic-ai/sdk";
import { getEnv, requireEnv } from "@/lib/env";

// High-powered model — reserved for the work that justifies the cost: org
// research and outreach drafting (both via generateWithWebSearch).
export const CLAUDE_MODEL = "claude-opus-4-8";

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

/** Concatenate all text blocks from a Claude message. */
export function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
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
}): Promise<string> {
  const client = getAnthropicCheap();
  const message = await client.messages.create({
    model: CLAUDE_MODEL_CHEAP,
    max_tokens: opts.maxTokens ?? 2048,
    thinking: { type: "adaptive" },
    system: opts.system,
    messages: [{ role: "user", content: opts.userPrompt }],
  });
  return extractText(message);
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
}): Promise<string> {
  const client = getAnthropic();
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.userPrompt },
  ];

  const tools = [
    {
      type: "web_search_20260209" as const,
      name: "web_search" as const,
      max_uses: opts.maxSearches ?? 8,
    },
  ];

  // Single deadline shared across pause_turn resumes — a stuck call can never
  // exceed this, so Discover always terminates rather than loading forever.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 240_000);

  let continuations = 0;
  // Loop only to resume on pause_turn.
  for (;;) {
    const stream = client.messages.stream(
      {
        model: CLAUDE_MODEL,
        max_tokens: opts.maxTokens ?? 16000,
        thinking: { type: "adaptive" },
        system: opts.system,
        tools,
        messages,
      },
      { signal },
    );
    const message = await stream.finalMessage();

    if (message.stop_reason === "pause_turn" && continuations < 5) {
      continuations += 1;
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    return extractText(message);
  }
}
