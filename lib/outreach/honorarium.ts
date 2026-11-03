/**
 * Every first email has to tell the host this is a paid engagement. The
 * drafting prompt asks for it, but prompts aren't reliable and drafts written
 * before that rule (or edited by hand) can still sit in the queue, so the
 * send path runs this as a last check.
 */

/** Already names the money: "honorarium", "speaking fees", "fee arrangements". */
export const HONORARIUM_MENTION = /honorari(um|a)|\bfees?\b/i;

/** Cheryl's own wording, with "the honorarium" in place of "speaking fees". */
export const HONORARIUM_LINE =
  "If this is of interest, I would love to discuss timing, logistics, and the honorarium with you.";

/** A paragraph that opens the sign-off: "Looking forward...", "Best,", etc. */
const SIGN_OFF =
  /^(looking forward|best|warm(ly|est)?|thank(s| you)|sincerely|all the best|kind regards|regards|cheers)\b/i;

/**
 * Return the body unchanged if it already names the money. Otherwise insert
 * HONORARIUM_LINE as its own paragraph just above the sign-off. Returns null
 * when there is no sign-off to anchor on, so the caller can refuse to send
 * rather than guess where the line goes.
 */
export function ensureHonorarium(body: string): string | null {
  if (HONORARIUM_MENTION.test(body)) return body;

  const paragraphs = body.split(/\n\s*\n/);
  const signOff = paragraphs.findIndex(
    (p, i) => i > 0 && SIGN_OFF.test(p.trim()),
  );
  if (signOff === -1) return null;

  paragraphs.splice(signOff, 0, HONORARIUM_LINE);
  return paragraphs.join("\n\n");
}
