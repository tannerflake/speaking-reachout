import type { CopyStyleValue, TailoringRule } from "@/lib/types";

/**
 * Collect the structured copy_style values from the active rule set.
 */
export function activeCopyStyle(rules: TailoringRule[]): CopyStyleValue[] {
  return rules
    .filter((r) => r.is_active && r.rule_type === "copy_style")
    .map((r) => r.structured_value as CopyStyleValue);
}

/**
 * Deterministic post-generation enforcement of hard copy_style constraints.
 * Prompt instructions alone aren't reliable, so we strip/rewrite violations
 * here (Section 6 of the spec). Currently enforces:
 *   - em-dash ban (forbid: ["em_dash"])
 *   - literal forbidden tokens (forbid: ["..."]) removed case-insensitively
 */
export function enforceStyle(
  text: string,
  rules: TailoringRule[],
): { text: string; changed: boolean } {
  const styles = activeCopyStyle(rules);
  let out = text;

  const forbids = new Set<string>();
  for (const s of styles) {
    for (const f of s.forbid ?? []) forbids.add(f.toLowerCase().trim());
  }

  const before = out;

  // Em-dash / en-dash ban.
  if (
    forbids.has("em_dash") ||
    forbids.has("em-dash") ||
    forbids.has("emdash") ||
    forbids.has("—")
  ) {
    out = out
      .replace(/\s*—\s*/g, ", ") // em dash → comma
      .replace(/\s*–\s*/g, "-"); // en dash → hyphen
  }

  // Other literal forbidden tokens (whole-word, case-insensitive).
  for (const token of forbids) {
    if (["em_dash", "em-dash", "emdash", "—"].includes(token)) continue;
    if (!token) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    out = out.replace(re, "");
  }

  // Tidy whitespace introduced by removals.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: out, changed: out !== before };
}

/**
 * Build the copy_style guidance block injected into the outreach system
 * prompt. Soft guidance — the hard enforcement above is the backstop.
 */
export function copyStyleInstructions(rules: TailoringRule[]): string {
  const styles = activeCopyStyle(rules);
  if (styles.length === 0) return "";

  const lines: string[] = [];
  for (const s of styles) {
    if (s.tone) lines.push(`- Tone: ${s.tone}.`);
    if (s.emphasize?.length)
      lines.push(`- Emphasize: ${s.emphasize.join(", ")}.`);
    if (s.deemphasize?.length)
      lines.push(`- De-emphasize / avoid leaning on: ${s.deemphasize.join(", ")}.`);
    if (s.forbid?.length) {
      const human = s.forbid.map((f) =>
        f === "em_dash" ? "em-dashes (—)" : f,
      );
      lines.push(`- Never use: ${human.join(", ")}.`);
    }
    if (typeof s.max_words === "number")
      lines.push(`- Keep the body under roughly ${s.max_words} words.`);
    for (const instr of s.instructions ?? []) lines.push(`- ${instr}`);
  }

  if (lines.length === 0) return "";
  return `\nThe operator has set these style rules — follow them strictly:\n${lines.join("\n")}\n`;
}
