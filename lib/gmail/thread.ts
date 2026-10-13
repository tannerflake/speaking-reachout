import { getGmailClient } from "@/lib/gmail/send";
import { isAutomatedMessage } from "@/lib/outreach/guard";

export interface ThreadMessage {
  id: string;
  /** RFC 2822 Message-ID header (used for In-Reply-To / References). */
  rfcMessageId: string | null;
  from: string;
  date: string; // ISO
  isFromUs: boolean;
  isBounce: boolean;
  /** Out-of-office / autoresponder: not a response from a person. */
  isAutoReply: boolean;
}

export interface ThreadState {
  messages: ThreadMessage[];
  /** A message from a person: not ours, not a bounce, not an auto-reply. */
  hasReply: boolean;
  hasBounce: boolean;
  /** Message-ID of the last message we sent (what a follow-up replies to). */
  lastOurRfcId: string | null;
  /** All Message-IDs in thread order, for the References header. */
  references: string[];
}

function looksLikeBounce(from: string): boolean {
  const f = from.toLowerCase();
  return f.includes("mailer-daemon") || f.includes("postmaster");
}

/**
 * RFC 3834 Auto-Submitted plus the common vendor headers autoresponders set,
 * with the subject/sender heuristics as a fallback.
 */
function looksLikeAutoReply(header: (name: string) => string): boolean {
  const autoSubmitted = header("Auto-Submitted").trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (header("X-Autoreply") || header("X-Autorespond")) return true;
  if (/^(auto_reply|bulk|junk)$/i.test(header("Precedence").trim())) return true;
  return isAutomatedMessage(header("From"), header("Subject"));
}

/**
 * Read a Gmail thread's metadata (headers only, no bodies) so a follow-up can
 * (a) confirm nobody has replied yet and (b) thread itself correctly.
 */
export async function getThreadState(threadId: string): Promise<ThreadState> {
  const { gmail, conn } = await getGmailClient();
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: [
      "From",
      "Subject",
      "Message-ID",
      "Date",
      "Auto-Submitted",
      "X-Autoreply",
      "X-Autorespond",
      "Precedence",
    ],
  });

  const ours = (conn.email ?? "").toLowerCase();
  const messages: ThreadMessage[] = [];
  for (const m of res.data.messages ?? []) {
    if (!m.id) continue;
    const headers = m.payload?.headers ?? [];
    const header = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value ?? "";
    const from = header("From");
    const labels = m.labelIds ?? [];
    const isFromUs =
      labels.includes("SENT") ||
      (ours.length > 0 && from.toLowerCase().includes(ours));
    const isBounce = !isFromUs && looksLikeBounce(from);
    messages.push({
      id: m.id,
      rfcMessageId: header("Message-ID") || null,
      from,
      date: m.internalDate
        ? new Date(Number(m.internalDate)).toISOString()
        : new Date(0).toISOString(),
      isFromUs,
      isBounce,
      isAutoReply: !isFromUs && !isBounce && looksLikeAutoReply(header),
    });
  }
  messages.sort((a, b) => a.date.localeCompare(b.date));

  const lastOurs = [...messages].reverse().find((m) => m.isFromUs);
  return {
    messages,
    hasReply: messages.some((m) => !m.isFromUs && !m.isBounce && !m.isAutoReply),
    hasBounce: messages.some((m) => m.isBounce),
    lastOurRfcId: lastOurs?.rfcMessageId ?? null,
    references: messages
      .map((m) => m.rfcMessageId)
      .filter((v): v is string => Boolean(v)),
  };
}
