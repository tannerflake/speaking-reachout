import { google } from "googleapis";
import { createOAuthClient } from "@/lib/gmail/oauth";
import { getGmailConnection, saveGmailTokens } from "@/lib/gmail/connection";

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
}): Promise<SendResult> {
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
  const raw = buildRawMessage({
    to: params.to,
    from: conn.email ?? undefined,
    subject: params.subject,
    body: params.body,
  });

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  const messageId = res.data.id ?? "";
  const threadId = res.data.threadId ?? "";
  if (!messageId) throw new Error("Gmail send returned no message id.");
  return { messageId, threadId };
}

function buildRawMessage(opts: {
  to: string;
  from?: string;
  subject: string;
  body: string;
}): string {
  const headers = [
    `To: ${opts.to}`,
    opts.from ? `From: ${opts.from}` : null,
    `Subject: ${encodeHeader(opts.subject)}`,
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
