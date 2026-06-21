// Hard site rule: NO em dashes anywhere in public copy or UI microcopy.
// We enforce this both in the AI editor's system prompt and with this
// deterministic post-processing pass over every string that reaches the store.

/**
 * Replace em dashes (and the en dash) with grammatical alternatives:
 *  - " — " / " – "  (spaced)  -> ", "  (comma)
 *  - "word—word"    (tight)   -> "word, word"
 * Any stray dash is collapsed to a comma so none survive.
 */
export function stripEmDashes(input: string): string {
  return input
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ", ")
    .trim();
}

/** Recursively strip em dashes from every string in a JSON-safe value. */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") {
    return stripEmDashes(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDeep(v);
    }
    return out as T;
  }
  return value;
}

/** True if the text contains an em or en dash (for validation/UI warnings). */
export function hasEmDash(input: string): boolean {
  return /[—–]/.test(input);
}
