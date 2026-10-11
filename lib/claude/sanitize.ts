/**
 * Remove citation markup the model sometimes writes literally into its text.
 *
 * When web search is enabled, Claude is trained to attach citations to its
 * prose. Structured citations ride alongside the text block, but when the
 * model is asked to return JSON it cannot attach them to a string field, so
 * it falls back to emitting the markup inline: `<cite index="8-2,8-3">...</cite>`.
 * That then landed verbatim in sent emails (seen 2026-10-11). Every string
 * that comes back from a model call passes through here, and the Gmail send
 * path strips again as a last line of defense.
 */
export function stripCitationTags(text: string): string {
  return (
    text
      // Opening and closing tags, with any attributes.
      .replace(/<\/?(?:antml:)?cite\b[^>]*>/gi, "")
      // Tidy doubled spaces left behind where a tag sat between words.
      .replace(/[ \t]{2,}/g, " ")
      .replace(/ ([,.;:!?])/g, "$1")
  );
}
