import { google } from "googleapis";
import { createOAuthClient } from "@/lib/gmail/oauth";
import { getGmailConnection, saveGmailTokens } from "@/lib/gmail/connection";
import { stripCitationTags } from "@/lib/claude/sanitize";

export class GmailNotConnectedError extends Error {
  constructor() {
    super("Gmail is not connected. Connect a Google account in Settings.");
    this.name = "GmailNotConnectedError";
  }
}

export interface SendResult {
  messageId: string;
  threadId: string;
}

/**
 * Send a plain-text email from the connected Gmail account via the Gmail API
 * (`users.messages.send`). Server-only — uses the stored refresh token.
 */
export async function sendGmail(params: {
  to: string;
  subject: string;
  body: string;
  /**
   * Reply-in-thread options. When set, the message is appended to the given
   * Gmail thread and carries In-Reply-To/References headers so every mail
   * client renders it as a reply to the original, not a new email.
   */
  thread?: {
    threadId: string;
    /** RFC 2822 Message-ID of the message being replied to. */
    inReplyTo?: string | null;
    /** RFC 2822 Message-IDs of the whole thread so far, oldest first. */
    references?: string[];
  };
}): Promise<SendResult> {
  const { gmail, conn } = await getGmailClient();
  // Last line of defense: model citation markup must never reach a recipient,
  // even if a draft was stored before the generators learned to strip it.
  const subject = stripCitationTags(params.subject).trim();
  const body = stripCitationTags(params.body).trim();
  const raw = buildRawMessage({
    to: params.to,
    from: conn.email ?? undefined,
    subject,
    body,
    inReplyTo: params.thread?.inReplyTo ?? undefined,
    references: params.thread?.references,
  });

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId: params.thread?.threadId,
    },
  });

  const messageId = res.data.id ?? "";
  const threadId = res.data.threadId ?? "";
  if (!messageId) throw new Error("Gmail send returned no message id.");
  return { messageId, threadId };
}

/**
 * Authenticated Gmail API client for the connected account, with token
 * refreshes persisted. Shared by send + follow-up thread checks.
 */
export async function getGmailClient(): Promise<{
  gmail: ReturnType<typeof google.gmail>;
  conn: { email: string | null };
}> {
  const conn = await getGmailConnection();
  if (!conn?.refresh_token) throw new GmailNotConnectedError();

  const oauth = createOAuthClient();
  oauth.setCredentials({
    refresh_token: conn.refresh_token,
    access_token: conn.access_token ?? undefined,
    expiry_date: conn.expiry ? new Date(conn.expiry).getTime() : undefined,
  });

  // Persist refreshed tokens so we don't re-mint on every send.
  oauth.on("tokens", (tokens) => {
    void saveGmailTokens({
      email: conn.email,
      refresh_token: tokens.refresh_token ?? conn.refresh_token,
      access_token: tokens.access_token ?? conn.access_token,
      expiry: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : conn.expiry,
    });
  });

  const gmail = google.gmail({ version: "v1", auth: oauth });
  return { gmail, conn: { email: conn.email } };
}

function buildRawMessage(opts: {
  to: string;
  from?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
}): string {
  const headers = [
    `To: ${opts.to}`,
    opts.from ? `From: ${opts.from}` : null,
    `Subject: ${encodeHeader(opts.subject)}`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : null,
    opts.references?.length ? `References: ${opts.references.join(" ")}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
  ].filter(Boolean);

  const message = `${headers.join("\r\n")}\r\n\r\n${opts.body}`;
  return Buffer.from(message, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** RFC 2047-encode a header value if it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}
