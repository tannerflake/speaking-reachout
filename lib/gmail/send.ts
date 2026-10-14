import { google } from "googleapis";
import { createOAuthClient } from "@/lib/gmail/oauth";
import { getGmailConnection, saveGmailTokens } from "@/lib/gmail/connection";
import { stripCitationTags } from "@/lib/claude/sanitize";
import type { EmailAttachment } from "@/lib/gmail/attachments";

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
 * Send a plain-text email (optionally with file attachments) from the
 * connected Gmail account via the Gmail API (`users.messages.send`).
 * Server-only — uses the stored refresh token.
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
  /** Files to attach. The message becomes multipart/mixed when non-empty. */
  attachments?: EmailAttachment[];
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
    attachments: params.attachments,
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

export function buildRawMessage(opts: {
  to: string;
  from?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: EmailAttachment[];
}): string {
  return base64Url(buildMimeMessage(opts));
}

/**
 * Build the RFC 2822 message text. Plain text/plain when there are no
 * attachments; otherwise multipart/mixed with the text body first and each
 * attachment as a base64 part. Exported for tests.
 */
export function buildMimeMessage(opts: {
  to: string;
  from?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: EmailAttachment[];
}): string {
  const headers = [
    `To: ${opts.to}`,
    opts.from ? `From: ${opts.from}` : null,
    `Subject: ${encodeHeader(opts.subject)}`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : null,
    opts.references?.length ? `References: ${opts.references.join(" ")}` : null,
    "MIME-Version: 1.0",
  ].filter(Boolean) as string[];

  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    opts.body,
  ].join("\r\n");

  const attachments = opts.attachments ?? [];
  if (attachments.length === 0) {
    return `${headers.join("\r\n")}\r\n${textPart}`;
  }

  const boundary = `----=_Part_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts = [textPart];
  for (const a of attachments) {
    const name = encodeHeader(a.filename);
    parts.push(
      [
        `Content-Type: ${a.mimeType}; name="${name}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${name}"`,
        "",
        // RFC 2045: base64 lines must be at most 76 characters.
        a.content.toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd(),
      ].join("\r\n"),
    );
  }

  const bodyText = parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${bodyText}\r\n--${boundary}--\r\n`;
}

function base64Url(message: string): string {
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
