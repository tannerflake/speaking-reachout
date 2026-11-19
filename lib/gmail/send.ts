import { google } from "googleapis";
import { createOAuthClient } from "@/lib/gmail/oauth";
import { getGmailConnection, saveGmailTokens } from "@/lib/gmail/connection";
import { stripCitationTags } from "@/lib/claude/sanitize";
import type { EmailAttachment } from "@/lib/gmail/attachments";
import { withGmailRetry } from "@/lib/gmail/retry";
import { getEnv } from "@/lib/env";

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
 * Send a plain-text, one-to-one email (attachments only if a caller insists;
 * outreach sends none, see lib/outreach/plainEmail.ts) from the
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
    from: conn.email ? await fromHeader(gmail, conn.email) : undefined,
    subject,
    body,
    inReplyTo: params.thread?.inReplyTo ?? undefined,
    references: params.thread?.references,
    attachments: params.attachments,
  });

  // Retry only rate-limit refusals: a 5xx might have delivered the message,
  // and a second attempt would send it twice.
  const res = await withGmailRetry(
    () =>
      gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw,
          threadId: params.thread?.threadId,
        },
      }),
    { retryServerErrors: false },
  );

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

let cachedFrom: { email: string; header: string } | null = null;

/**
 * "Cheryl Flake <cheryl@jeffflake.com>" rather than a bare address: a missing
 * display name is a small but real bulk-mail signal and looks cold in the
 * inbox. SENDER_NAME wins; otherwise the Gmail "send as" display name; the
 * bare address only if neither is available.
 */
async function fromHeader(
  gmail: ReturnType<typeof google.gmail>,
  email: string,
): Promise<string> {
  const configured = getEnv("SENDER_NAME");
  if (configured) return formatAddress(configured, email);
  if (cachedFrom?.email === email) return cachedFrom.header;
  let name = "";
  try {
    const res = await gmail.users.settings.sendAs.get({ userId: "me", sendAsEmail: email });
    name = res.data.displayName?.trim() ?? "";
  } catch {
    // Settings read needs the read-only scope; fall back to the address.
  }
  const header = name ? formatAddress(name, email) : email;
  cachedFrom = { email, header };
  return header;
}

function formatAddress(name: string, email: string): string {
  const clean = name.replace(/["\\\r\n<>]/g, "").trim();
  if (!clean) return email;
  return /^[\x20-\x7E]*$/.test(clean)
    ? `"${clean}" <${email}>`
    : `${encodeHeader(clean)} <${email}>`;
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

  // Quoted-printable keeps every line legal (7-bit, under 76 characters)
  // whatever the text holds: curly quotes, accented names, long paragraphs.
  // Raw UTF-8 under a "7bit" label is malformed MIME, which filters notice.
  const textPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(opts.body),
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

/** RFC 2045 quoted-printable for a UTF-8 text body, CRLF line endings. */
export function encodeQuotedPrintable(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, "utf-8");
    const tokens: string[] = [];
    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1;
      if ((b === 0x20 || b === 0x09) && !last) tokens.push(String.fromCharCode(b));
      else if (b >= 33 && b <= 126 && b !== 61) tokens.push(String.fromCharCode(b));
      else tokens.push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`);
    });
    let cur = "";
    for (const t of tokens) {
      if (cur.length + t.length > 75) {
        out.push(`${cur}=`);
        cur = "";
      }
      cur += t;
    }
    out.push(cur);
  }
  return out.join("\r\n");
}

/** RFC 2047-encode a header value if it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}
