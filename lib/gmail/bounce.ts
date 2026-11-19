/**
 * Delivery-failure detection, shared by the reply scanner, the follow-up
 * thread check and the engagement guard. A bounce is the mail system talking,
 * not a person: it is never a reply and never "already in contact".
 */

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (subsystem|system)|microsoftexchange[0-9a-f]{8,}|^\s*"?microsoft outlook"?\s*<)/i;

const BOUNCE_SUBJECT =
  /^\s*((re|fw|fwd)\s*:\s*)*(delivery status notification|undeliverable|undelivered|mail delivery (failed|failure|subsystem)|delivery (has )?failed|delivery failure|message (not delivered|delivery failure)|returned mail|failure notice|non[- ]?delivery|nondeliverable|could not be delivered|couldn't be delivered|wasn't delivered|address not found|unzustellbar|non remis|no entregado|mensaje no entregado|delivery incomplete)/i;

/** Delay warnings come from the same daemons but the mail is still trying. */
const DELAY = /(\(delay\)|delayed|delivery delay|warning: could not send|will retry|still trying|temporar)/i;

/** Wording of a permanent failure: the address doesn't exist or never will. */
const HARD =
  /(\b5\.\d\.\d+\b|\b55[0-4]\b|does not exist|doesn't exist|no such (user|recipient|mailbox)|user unknown|unknown user|recipient (address )?rejected|address (not found|rejected)|invalid (recipient|address|mailbox)|mailbox (unavailable|not found|disabled)|account (has been )?(disabled|closed|deleted|inactive)|not a valid|couldn't be found|could not be found|wasn't found|isn't a valid|unrouteable|no longer (with|at|employed))/i;

/** Wording of a temporary failure: a full mailbox, a busy server. */
const SOFT = /(\b4\.\d\.\d+\b|\b4[25]\d\b|mailbox (is )?full|over quota|quota exceeded|insufficient storage|try again later|temporar|timed? ?out|connection (refused|timed out)|greylist)/i;

export interface BounceInfo {
  /** Permanent: the address is bad; never send to it again. */
  hard: boolean;
  /** Recipients the failure names, lowercased. */
  failedRecipients: string[];
}

function headerOf(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : "";
}

/** Cheap check on From/Subject (and Content-Type when known). */
export function looksLikeDeliveryFailure(
  from: string,
  subject: string,
  headers?: Record<string, string>,
): boolean {
  if (DELAY.test(subject)) return false;
  if (/multipart\/report.*delivery-status/i.test(headerOf(headers, "Content-Type"))) return true;
  if (headerOf(headers, "X-Failed-Recipients")) return true;
  if (BOUNCE_SUBJECT.test(subject)) return true;
  return BOUNCE_FROM.test(from) && !/out of office|automatic reply/i.test(subject);
}

/**
 * Classify a message as a delivery failure, or null when it isn't one (or is
 * only a delay warning). Unclear wording counts as HARD: bouncing twice off
 * the same bad address costs more reputation than skipping one good one.
 */
export function classifyBounce(m: {
  from: string;
  subject: string;
  body?: string;
  headers?: Record<string, string>;
}): BounceInfo | null {
  if (!looksLikeDeliveryFailure(m.from, m.subject, m.headers)) return null;
  const body = m.body ?? "";
  if (DELAY.test(body.slice(0, 600)) && !HARD.test(body)) return null;
  const hard = HARD.test(body) || !SOFT.test(body);

  const failed = new Set<string>();
  for (const a of headerOf(m.headers, "X-Failed-Recipients").split(/[,\s]+/)) {
    if (a.includes("@")) failed.add(a.trim().toLowerCase());
  }
  // "Your message wasn't delivered to jane@x.edu", "Final-Recipient: rfc822; jane@x.edu"
  const patterns = [
    /final-recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/gi,
    /original-recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/gi,
    /(?:delivered to|delivery to|deliver(?:y)? to the following recipient[s]?:?|address(?:es)?|recipient(?:s)?)\s*:?\s*<?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?/gi,
  ];
  for (const re of patterns) {
    for (const match of body.matchAll(re)) failed.add(match[1].replace(/[.,;]+$/, "").toLowerCase());
  }
  // Exchange lists the failed addresses on their own lines under "Delivery
  // has failed to these recipients or groups:". Fall back to every address in
  // the top of the report; callers only act on ones they actually emailed.
  if (failed.size === 0) {
    for (const match of body.slice(0, 2000).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      const a = match[0].toLowerCase();
      if (!/(mailer-daemon|postmaster|microsoftexchange)/.test(a)) failed.add(a);
    }
  }
  return { hard, failedRecipients: [...failed] };
}
