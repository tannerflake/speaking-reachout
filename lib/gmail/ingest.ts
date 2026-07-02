import { google, type gmail_v1 } from "googleapis";
import { createOAuthClient } from "@/lib/gmail/oauth";
import { getGmailConnection, saveGmailTokens } from "@/lib/gmail/connection";
import { GmailNotConnectedError } from "@/lib/gmail/send";
import { mapWithConcurrency } from "@/lib/utils";
import type { IngestedMessage } from "@/lib/types";

export class GmailReadScopeMissingError extends Error {
  constructor() {
    super(
      "Gmail read access not granted. Reconnect Gmail and allow read-only access.",
    );
    this.name = "GmailReadScopeMissingError";
  }
}

async function getReadGmail(): Promise<gmail_v1.Gmail> {
  const conn = await getGmailConnection();
  if (!conn?.refresh_token) throw new GmailNotConnectedError();

  const oauth = createOAuthClient();
  oauth.setCredentials({
    refresh_token: conn.refresh_token,
    access_token: conn.access_token ?? undefined,
    expiry_date: conn.expiry ? new Date(conn.expiry).getTime() : undefined,
  });
  oauth.on("tokens", (tokens) => {
    void saveGmailTokens({
      email: conn.email,
      refresh_token: tokens.refresh_token ?? conn.refresh_token,
      access_token: tokens.access_token ?? conn.access_token,
      expiry: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : conn.expiry,
      scopes: conn.scopes,
    });
  });
  return google.gmail({ version: "v1", auth: oauth });
}

async function listIds(
  gmail: gmail_v1.Gmail,
  labelIds: string[],
  cap: number,
): Promise<Array<{ id: string }>> {
  const out: Array<{ id: string }> = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds,
      maxResults: 500,
      pageToken,
    });
    for (const m of res.data.messages ?? []) {
      if (m.id) out.push({ id: m.id });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && out.length < cap);
  return out.slice(0, cap);
}

export interface IngestResult {
  messages: IngestedMessage[];
  listedSent: number;
  listedInbox: number;
  skippedAlreadyProcessed: number;
}

/**
 * Fetch Gmail messages (SENT + INBOX), skipping any already processed.
 * Returns in-memory messages — callers analyze and discard; raw bodies are
 * never persisted.
 */
export async function ingestMessages(opts: {
  processedIds: Set<string>;
  sentCap?: number;
  inboxCap?: number;
  concurrency?: number;
  /**
   * Skip listing SENT and fetch only INBOX. Used by the reply scanner, which
   * cares only about inbound responses/bounces — our own sent copies are noise.
   */
  inboxOnly?: boolean;
}): Promise<IngestResult> {
  const gmail = await getReadGmail();

  let sentList: Array<{ id: string }> = [];
  try {
    if (!opts.inboxOnly) {
      sentList = await listIds(gmail, ["SENT"], opts.sentCap ?? 1500);
    }
  } catch (e) {
    // 403 / insufficient permission → readonly scope wasn't granted.
    if (isScopeError(e)) throw new GmailReadScopeMissingError();
    throw e;
  }

  let inboxList: Array<{ id: string }>;
  try {
    inboxList = await listIds(gmail, ["INBOX"], opts.inboxCap ?? 1500);
  } catch (e) {
    if (isScopeError(e)) throw new GmailReadScopeMissingError();
    throw e;
  }

  // Dedup ids, then drop already-processed. SENT first (primary voice signal).
  const seen = new Set<string>();
  const ordered: string[] = [];
  let skipped = 0;
  for (const { id } of [...sentList, ...inboxList]) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (opts.processedIds.has(id)) {
      skipped += 1;
      continue;
    }
    ordered.push(id);
  }

  const fetched = await mapWithConcurrency(
    ordered,
    opts.concurrency ?? 10,
    async (id) => {
      try {
        return await fetchMessage(gmail, id);
      } catch {
        return null;
      }
    },
  );

  return {
    messages: fetched.filter((m): m is IngestedMessage => m !== null),
    listedSent: sentList.length,
    listedInbox: inboxList.length,
    skippedAlreadyProcessed: skipped,
  };
}

async function fetchMessage(
  gmail: gmail_v1.Gmail,
  id: string,
): Promise<IngestedMessage | null> {
  const res = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  const m = res.data;
  if (!m.id) return null;

  const payload = m.payload;
  const headers = payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name)?.value ?? "";

  const labels = m.labelIds ?? [];
  const internalDate = m.internalDate
    ? new Date(Number(m.internalDate)).toISOString()
    : new Date(0).toISOString();

  return {
    id: m.id,
    threadId: m.threadId ?? m.id,
    labels,
    internalDate,
    from: header("from"),
    to: header("to"),
    subject: header("subject"),
    body: cleanBody(extractBody(payload)),
    isSent: labels.includes("SENT"),
  };
}

function decode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

function findPart(
  parts: gmail_v1.Schema$MessagePart[],
  mime: string,
): gmail_v1.Schema$MessagePart | null {
  for (const p of parts) {
    if (p.mimeType === mime && p.body?.data) return p;
    if (p.parts) {
      const nested = findPart(p.parts, mime);
      if (nested) return nested;
    }
  }
  return null;
}

function extractBody(
  payload: gmail_v1.Schema$MessagePart | undefined,
): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decode(payload.body.data);
  }
  if (payload.parts) {
    const plain = findPart(payload.parts, "text/plain");
    if (plain?.body?.data) return decode(plain.body.data);
    const html = findPart(payload.parts, "text/html");
    if (html?.body?.data) return stripHtml(decode(html.body.data));
  }
  if (payload.body?.data) return decode(payload.body.data);
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ");
}

/**
 * Strip quoted reply chains and signatures so analysis sees the actual
 * writing, not the whole forwarded history. Best-effort heuristics.
 */
function cleanBody(raw: string): string {
  let text = raw.replace(/\r\n/g, "\n");

  const cutMarkers: RegExp[] = [
    /\n[> ]*On .{0,120}wrote:/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n_{5,}\n/,
    /\nFrom:.{0,200}\nSent:/i,
    /\n[> ]*Le .{0,120}a écrit\s*:/i,
  ];
  for (const re of cutMarkers) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index > 0) {
      text = text.slice(0, m.index);
    }
  }

  // Drop quoted lines.
  text = text
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n");

  // Strip signature block (RFC "-- " delimiter).
  const sigIdx = text.search(/\n-- \n/);
  if (sigIdx !== -1) text = text.slice(0, sigIdx);

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function isScopeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return (
    msg.includes("insufficient") ||
    msg.includes("permission") ||
    msg.includes("scope") ||
    msg.includes("403")
  );
}
