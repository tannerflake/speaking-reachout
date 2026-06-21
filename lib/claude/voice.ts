import { generateText } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import type {
  IngestedMessage,
  InsightCategory,
  RuleType,
} from "@/lib/types";

const RULE_TYPES: RuleType[] = [
  "discovery_filter",
  "copy_style",
  "targeting",
  "other",
];

export interface PriorProfile {
  tone_summary: string | null;
  structure_summary: string | null;
  tactics_summary: string | null;
  cadence_summary: string | null;
}

export interface AnalysisResult {
  tone_summary: string;
  structure_summary: string;
  tactics_summary: string;
  cadence_summary: string;
  prompt_injection: string;
  insights: Array<{
    category: InsightCategory;
    insight: string;
    example_excerpt: string | null;
  }>;
  suggested_rules: Array<{
    rule_type: RuleType;
    raw_instruction: string;
    structured_value: Record<string, unknown>;
  }>;
}

export class NoSentMailError extends Error {
  constructor() {
    super("No sent emails were found to analyze.");
    this.name = "NoSentMailError";
  }
}

interface PassResult {
  summary: string;
  insights: Array<{ insight: string; example_excerpt: string | null }>;
}

const SHARED_PRIVACY_NOTE =
  "These are private emails. Do not reproduce third-party personal data, full email addresses, or long verbatim passages. Keep any example_excerpt under 200 characters and drawn from Jeff's own sent writing.";

function fmtEmail(m: IngestedMessage, maxChars = 1600): string {
  const body = m.body.replace(/\s+\n/g, "\n").slice(0, maxChars);
  return `Subject: ${m.subject || "(none)"}\n${body}`;
}

function byDateDesc(a: IngestedMessage, b: IngestedMessage): number {
  return b.internalDate.localeCompare(a.internalDate);
}

function buildThreads(messages: IngestedMessage[]) {
  const threads = new Map<
    string,
    { sent: IngestedMessage[]; received: IngestedMessage[] }
  >();
  for (const m of messages) {
    const t = threads.get(m.threadId) ?? { sent: [], received: [] };
    (m.isSent ? t.sent : t.received).push(m);
    threads.set(m.threadId, t);
  }
  return threads;
}

async function runPass(
  system: string,
  userPrompt: string,
  summaryKey: string,
): Promise<PassResult> {
  const text = await generateText({
    system,
    userPrompt,
    maxTokens: 3500,
  });
  try {
    const parsed = extractJson<Record<string, unknown>>(text);
    const summary =
      typeof parsed[summaryKey] === "string"
        ? (parsed[summaryKey] as string)
        : "";
    const rawInsights = Array.isArray(parsed.insights) ? parsed.insights : [];
    const insights = rawInsights
      .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
      .slice(0, 6)
      .map((i) => ({
        insight: typeof i.insight === "string" ? i.insight : "",
        example_excerpt:
          typeof i.example_excerpt === "string" ? i.example_excerpt : null,
      }))
      .filter((i) => i.insight);
    return { summary, insights };
  } catch {
    return { summary: text.slice(0, 1200), insights: [] };
  }
}

export async function analyzeCorpus(
  messages: IngestedMessage[],
  prior?: PriorProfile,
): Promise<AnalysisResult> {
  const sent = messages
    .filter((m) => m.isSent && m.body.trim().length > 30)
    .sort(byDateDesc);
  const threads = buildThreads(messages);

  if (sent.length === 0 && !prior) throw new NoSentMailError();

  // --- corpus slices --------------------------------------------------------
  const voiceSample = sent.slice(0, 40);

  // Success vs non-response openers.
  const repliedOpeners: IngestedMessage[] = [];
  const noReplyOpeners: IngestedMessage[] = [];
  for (const t of threads.values()) {
    if (t.sent.length === 0) continue;
    const opener = [...t.sent].sort((a, b) =>
      a.internalDate.localeCompare(b.internalDate),
    )[0];
    const earliestSent = opener.internalDate;
    const gotReply = t.received.some((r) => r.internalDate > earliestSent);
    if (gotReply) repliedOpeners.push(opener);
    else noReplyOpeners.push(opener);
  }

  // Multi-touch threads for cadence.
  const cadenceThreads = [...threads.values()]
    .filter((t) => t.sent.length >= 2)
    .slice(0, 20);

  const priorBlock = (label: string, value: string | null | undefined) =>
    value
      ? `\n\nExisting notes for ${label} (refine and extend with the emails below; don't discard what still holds):\n${value}`
      : "";

  // --- passes (run concurrently) -------------------------------------------
  const [voice, tactics, structure, cadence] = await Promise.all([
    runPass(
      `You analyze the SENT emails of Jeff Flake (former U.S. Senator, now a paid public speaker) to capture HOW HE WRITES. Capture concrete, reusable markers — formality, warmth, sentence length, vocabulary, signature phrases, openings/closings, and what he avoids. Not vibes. ${SHARED_PRIVACY_NOTE}\nReturn ONLY JSON: {"tone_summary": string, "insights": [{"insight": string, "example_excerpt": string|null}]}`,
      `Here are ${voiceSample.length} of his sent emails.${priorBlock(
        "his voice/tone",
        prior?.tone_summary,
      )}\n\n${voiceSample.map(fmtEmail).join("\n\n---\n\n")}`,
      "tone_summary",
    ),
    runPass(
      `You compare Jeff Flake's outreach emails that GOT A REPLY against those that got NO REPLY, to identify what his winning emails do differently: openings, the specific ask, personalization depth, use of credibility/links, and length. ${SHARED_PRIVACY_NOTE}\nReturn ONLY JSON: {"tactics_summary": string, "insights": [{"insight": string, "example_excerpt": string|null}]}`,
      `GOT A REPLY (${repliedOpeners.length}):\n\n${repliedOpeners
        .slice(0, 25)
        .map((m) => fmtEmail(m, 1200))
        .join("\n\n---\n\n")}\n\n=====\n\nNO REPLY (${noReplyOpeners.length}):\n\n${noReplyOpeners
        .slice(0, 25)
        .map((m) => fmtEmail(m, 1200))
        .join("\n\n---\n\n")}${priorBlock("his winning tactics", prior?.tactics_summary)}`,
      "tactics_summary",
    ),
    runPass(
      `You extract the SKELETON of Jeff Flake's typical pitch email: how he opens, how he sequences the case, how he makes the ask, and how he closes. ${SHARED_PRIVACY_NOTE}\nReturn ONLY JSON: {"structure_summary": string, "insights": [{"insight": string, "example_excerpt": string|null}]}`,
      `Here are sent emails to derive his structure from.${priorBlock(
        "his message structure",
        prior?.structure_summary,
      )}\n\n${voiceSample.map((m) => fmtEmail(m, 1400)).join("\n\n---\n\n")}`,
      "structure_summary",
    ),
    runPass(
      `You analyze Jeff Flake's FOLLOW-UP behavior from threads where he sent multiple touches: how long he waits between touches, how many touches he sends, and how follow-ups differ in tone from first contact. ${SHARED_PRIVACY_NOTE}\nReturn ONLY JSON: {"cadence_summary": string, "insights": [{"insight": string, "example_excerpt": string|null}]}`,
      cadenceThreads.length
        ? `Multi-touch threads (each block is one thread, his touches in order with dates):\n\n${cadenceThreads
            .map((t, i) => {
              const ordered = [...t.sent].sort((a, b) =>
                a.internalDate.localeCompare(b.internalDate),
              );
              const touches = ordered
                .map(
                  (m, j) =>
                    `Touch ${j + 1} (${m.internalDate.slice(0, 10)}): ${m.body.slice(0, 400)}`,
                )
                .join("\n");
              return `THREAD ${i + 1}:\n${touches}`;
            })
            .join("\n\n---\n\n")}${priorBlock("his cadence", prior?.cadence_summary)}`
        : `Limited multi-touch data available.${priorBlock(
            "his cadence",
            prior?.cadence_summary,
          )}\nInfer cadence cautiously from what's known and note the limited sample.`,
      "cadence_summary",
    ),
  ]);

  // --- synthesis ------------------------------------------------------------
  const synthText = await generateText({
    system: `You synthesize four analysis passes about how Jeff Flake writes outreach into (1) a tight, high-signal "prompt_injection" block that will be inserted into an AI email-drafting system prompt on EVERY generation so drafts sound like him and use his proven moves, and (2) a set of suggested tailoring rules in the app's rule format.

The prompt_injection must be concise and directive (think 150-250 words), written as guidance to the drafting AI ("Write in Jeff's voice: ...", "Open with ...", "Keep first-contact emails under N words", etc.). No preamble.

Suggested rules use rule_type one of: "copy_style" (how to write — most common here), "targeting", "discovery_filter". Each rule: a short human "raw_instruction" (what a person would type) and a "structured_value" object the engine applies. For copy_style use keys among: tone (string), emphasize (string[]), deemphasize (string[]), forbid (string[], e.g. ["em_dash"]), max_words (number), instructions (string[]). Propose 4-8 concrete, non-redundant rules grounded in the findings.

Return ONLY JSON: {"prompt_injection": string, "suggested_rules": [{"rule_type": string, "raw_instruction": string, "structured_value": object}]}`,
    userPrompt: `VOICE/TONE:\n${voice.summary}\n\nTACTICS:\n${tactics.summary}\n\nSTRUCTURE:\n${structure.summary}\n\nCADENCE:\n${cadence.summary}`,
    maxTokens: 3000,
  });

  let prompt_injection = "";
  let suggested_rules: AnalysisResult["suggested_rules"] = [];
  try {
    const synth = extractJson<{
      prompt_injection?: unknown;
      suggested_rules?: unknown;
    }>(synthText);
    prompt_injection =
      typeof synth.prompt_injection === "string" ? synth.prompt_injection : "";
    if (Array.isArray(synth.suggested_rules)) {
      suggested_rules = synth.suggested_rules
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .map((r) => ({
          rule_type: RULE_TYPES.includes(r.rule_type as RuleType)
            ? (r.rule_type as RuleType)
            : "copy_style",
          raw_instruction:
            typeof r.raw_instruction === "string" ? r.raw_instruction : "",
          structured_value:
            r.structured_value && typeof r.structured_value === "object"
              ? (r.structured_value as Record<string, unknown>)
              : {},
        }))
        .filter((r) => r.raw_instruction)
        .slice(0, 8);
    }
  } catch {
    prompt_injection = synthText.slice(0, 1500);
  }

  const insights: AnalysisResult["insights"] = [];
  const push = (category: InsightCategory, pass: PassResult) => {
    for (const i of pass.insights)
      insights.push({ category, insight: i.insight, example_excerpt: i.example_excerpt });
  };
  push("voice", voice);
  push("tactics", tactics);
  push("structure", structure);
  push("cadence", cadence);

  return {
    tone_summary: voice.summary,
    structure_summary: structure.summary,
    tactics_summary: tactics.summary,
    cadence_summary: cadence.summary,
    prompt_injection,
    insights,
    suggested_rules,
  };
}
