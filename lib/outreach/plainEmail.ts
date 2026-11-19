import { getEnv } from "@/lib/env";

/**
 * Outreach must read like one person writing to another: plain text, no
 * attachment, at most a couple of ordinary links and never a shortener. Bulk
 * and marketing mail has the opposite fingerprint, and a PDF from a stranger
 * is one of the strongest spam signals there is.
 */

/** Link shorteners hide the destination; spam filters treat them as a red flag. */
const SHORTENERS =
  /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|buff\.ly|rebrand\.ly|is\.gd|cutt\.ly|shorturl\.at|lnkd\.in|tiny\.cc|rb\.gy|t\.ly|s\.id|bl\.ink|short\.io)\//i;

const URL_RE = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi;

export const MAX_LINKS_FIRST_EMAIL = 2;

/** Old behavior (PDF one-pager on every first email), off unless asked for. */
export function attachOnePager(): boolean {
  return getEnv("OUTREACH_ATTACH_ONE_PAGER") === "true";
}

/** Body text that promises an attachment we no longer send. */
export function mentionsAttachment(body: string): boolean {
  return /\b(attached|attachment|enclosed|i(?:'| ha)ve attached|please find (?:the|my|our)?\s*\w*\s*(?:overview|one-pager|pdf))\b/i.test(
    body,
  );
}

export function linkCount(body: string): number {
  return (body.match(URL_RE) ?? []).length;
}

/**
 * Why this body would look bulk or broken, or null when it reads as a plain
 * personal email. Checked when queueing and again at send time.
 */
export function plainEmailProblem(body: string, opts: { firstEmail: boolean }): string | null {
  if (SHORTENERS.test(body)) {
    return "Not sent: the email contains a link shortener (bit.ly and the like), which spam filters treat as a red flag. Use the full link or drop it.";
  }
  if (/<\s*(img|a|div|table|span|p|br)\b[^>]*>/i.test(body)) {
    return "Not sent: the email contains HTML markup. Outreach goes out as plain text; remove the tags.";
  }
  if (opts.firstEmail) {
    const links = linkCount(body);
    if (links > MAX_LINKS_FIRST_EMAIL) {
      return `Not sent: the email has ${links} links. A first email to a stranger should have ${MAX_LINKS_FIRST_EMAIL} at most (ideally none); trim them.`;
    }
    if (!attachOnePager() && mentionsAttachment(body)) {
      return 'Not sent: the email says something is attached, but outreach no longer carries attachments (a PDF from a stranger looks like spam). Change the line to an offer, e.g. "I would be happy to send a one-page overview of Jeff\'s talks."';
    }
  }
  return null;
}
