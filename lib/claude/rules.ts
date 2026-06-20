import { generateText } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import type {
  DiscoveredLead,
  DiscoveryFilterValue,
  RuleType,
  TailoringRule,
  TargetingValue,
} from "@/lib/types";

const RULE_TYPES: RuleType[] = [
  "discovery_filter",
  "copy_style",
  "targeting",
  "other",
];

const RULE_PARSE_SYSTEM = `You convert a single natural-language instruction from the operator of a speaking-engagement outreach tool into a structured rule the engine can apply deterministically.

Classify the instruction into exactly one rule_type:
- "discovery_filter": which leads to include/exclude when discovering (countries, keywords).
- "targeting": what kinds of venues to prioritize/deprioritize, or a focus area.
- "copy_style": how outreach emails should be written (tone, forbidden things, length).
- "other": anything that doesn't fit above.

Emit a "structured_value" object the engine reads. Use these shapes where they apply:
- discovery_filter: { "exclude_countries": ["United Kingdom"], "include_countries": [...], "exclude_keywords": [...] }
- targeting: { "prioritize_types": ["university","fintech_conference"], "deprioritize_types": [...], "focus": "..." }
- copy_style: { "tone": "academic", "emphasize": [...], "deemphasize": ["political"], "forbid": ["em_dash"], "max_words": 220, "instructions": ["..."] }

Rules:
- Use full country names (e.g. "United Kingdom", not "UK").
- For an em-dash ban, put "em_dash" in forbid.
- Only include keys that the instruction actually implies. Omit empty keys.
- Return ONLY a JSON object with keys "rule_type" and "structured_value". No prose, no markdown.

Examples:
"Don't pull any leads from the UK" -> {"rule_type":"discovery_filter","structured_value":{"exclude_countries":["United Kingdom"]}}
"No em-dashes in any outreach" -> {"rule_type":"copy_style","structured_value":{"forbid":["em_dash"]}}
"Lean more academic, less political" -> {"rule_type":"copy_style","structured_value":{"tone":"academic","deemphasize":["political"]}}
"Prioritize universities and fintech conferences" -> {"rule_type":"targeting","structured_value":{"prioritize_types":["university","fintech_conference"]}}`;

export interface ParsedRule {
  rule_type: RuleType;
  structured_value: Record<string, unknown>;
}

/** Parse a raw operator instruction into a structured, persistable rule. */
export async function parseRuleInstruction(raw: string): Promise<ParsedRule> {
  const text = await generateText({
    system: RULE_PARSE_SYSTEM,
    userPrompt: raw,
    maxTokens: 1024,
  });

  let parsed: ParsedRule;
  try {
    parsed = extractJson<ParsedRule>(text);
  } catch {
    // Graceful fallback: store as an "other" rule preserving the raw text.
    return { rule_type: "other", structured_value: { note: raw } };
  }

  const rule_type = RULE_TYPES.includes(parsed.rule_type)
    ? parsed.rule_type
    : "other";
  const structured_value =
    parsed.structured_value && typeof parsed.structured_value === "object"
      ? parsed.structured_value
      : {};

  return { rule_type, structured_value };
}

// --- Discovery-prompt context ----------------------------------------------

function discoveryFilters(rules: TailoringRule[]): DiscoveryFilterValue[] {
  return rules
    .filter((r) => r.is_active && r.rule_type === "discovery_filter")
    .map((r) => r.structured_value as DiscoveryFilterValue);
}

function targetingValues(rules: TailoringRule[]): TargetingValue[] {
  return rules
    .filter((r) => r.is_active && r.rule_type === "targeting")
    .map((r) => r.structured_value as TargetingValue);
}

/**
 * Human-readable summary of the active discovery/targeting rules, for the
 * Discover UI ("what's being filtered").
 */
export function describeDiscoveryRules(rules: TailoringRule[]): string[] {
  return rules
    .filter(
      (r) =>
        r.is_active &&
        (r.rule_type === "discovery_filter" || r.rule_type === "targeting"),
    )
    .map((r) => r.raw_instruction);
}

/** Build the constraints block injected into the discovery prompt. */
export function discoveryRulesPrompt(rules: TailoringRule[]): string {
  const filters = discoveryFilters(rules);
  const targets = targetingValues(rules);
  const lines: string[] = [];

  const excludeCountries = filters.flatMap((f) => f.exclude_countries ?? []);
  const includeCountries = filters.flatMap((f) => f.include_countries ?? []);
  const excludeKeywords = filters.flatMap((f) => f.exclude_keywords ?? []);

  if (excludeCountries.length)
    lines.push(`- Do NOT return any lead located in: ${excludeCountries.join(", ")}.`);
  if (includeCountries.length)
    lines.push(`- Only return leads located in: ${includeCountries.join(", ")}.`);
  if (excludeKeywords.length)
    lines.push(
      `- Avoid leads related to: ${excludeKeywords.join(", ")}.`,
    );

  const prioritize = targets.flatMap((t) => t.prioritize_types ?? []);
  const deprioritize = targets.flatMap((t) => t.deprioritize_types ?? []);
  const focuses = targets.map((t) => t.focus).filter(Boolean) as string[];

  if (prioritize.length)
    lines.push(`- Prioritize these kinds of venues: ${prioritize.join(", ")}.`);
  if (deprioritize.length)
    lines.push(`- Deprioritize: ${deprioritize.join(", ")}.`);
  for (const f of focuses) lines.push(`- Focus: ${f}.`);

  if (lines.length === 0) return "";
  return `\nActive operator rules you MUST respect:\n${lines.join("\n")}\n`;
}

/**
 * Deterministic post-filter — drop candidates that violate discovery_filter
 * rules even if the model slipped one through (Section 6: post-filter results).
 */
export function filterDiscoveredLeads(
  candidates: DiscoveredLead[],
  rules: TailoringRule[],
): DiscoveredLead[] {
  const filters = discoveryFilters(rules);
  const exclude = new Set(
    filters
      .flatMap((f) => f.exclude_countries ?? [])
      .map((c) => c.toLowerCase().trim()),
  );
  const include = new Set(
    filters
      .flatMap((f) => f.include_countries ?? [])
      .map((c) => c.toLowerCase().trim()),
  );
  const keywords = filters
    .flatMap((f) => f.exclude_keywords ?? [])
    .map((k) => k.toLowerCase().trim())
    .filter(Boolean);

  return candidates.filter((c) => {
    const country = (c.location_country ?? "").toLowerCase().trim();
    if (exclude.size && country && exclude.has(country)) return false;
    if (include.size && (!country || !include.has(country))) return false;
    if (keywords.length) {
      const hay = `${c.name} ${c.description}`.toLowerCase();
      if (keywords.some((k) => hay.includes(k))) return false;
    }
    return true;
  });
}
