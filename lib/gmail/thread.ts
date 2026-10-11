import { getGmailClient } from "@/lib/gmail/send";

export interface ThreadMessage {
  id: string;
  /** RFC 2822 Message-ID header (used for In-Reply-To / References). */
  rfcMessageId: string | null;
  from: string;
  date: string; // ISO
  isFromUs: boolean;
  isBounce: boolean;
}

export interface ThreadState {
  messages: ThreadMessage[];
  /** Any message in the thread that we didn't send and isn't a bounce. */
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
 * Read a Gmail thread's metadata (headers only, no bodies) so a follow-up can
 * (a) confirm nobody has replied yet and (b) thread itself correctly.
 */
export async function getThreadState(threadId: string): Promise<ThreadState> {
  const { gmail, conn } = await getGmailClient();
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["From", "Message-ID", "Date"],
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
    messages.push({
      id: m.id,
      rfcMessageId: header("Message-ID") || null,
      from,
      date: m.internalDate
        ? new Date(Number(m.internalDate)).toISOString()
        : new Date(0).toISOString(),
      isFromUs,
      isBounce: !isFromUs && looksLikeBounce(from),
    });
  }
  messages.sort((a, b) => a.date.localeCompare(b.date));

  const lastOurs = [...messages].reverse().find((m) => m.isFromUs);
  return {
    messages,
    hasReply: messages.some((m) => !m.isFromUs && !m.isBounce),
    hasBounce: messages.some((m) => m.isBounce),
    lastOurRfcId: lastOurs?.rfcMessageId ?? null,
    references: messages
      .map((m) => m.rfcMessageId)
      .filter((v): v is string => Boolean(v)),
  };
}
