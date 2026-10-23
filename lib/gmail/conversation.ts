import { getGmailClient } from "@/lib/gmail/send";
import { cleanBody, extractBody } from "@/lib/gmail/ingest";
import { looksLikeAutoReply } from "@/lib/gmail/thread";
import { domainFromUrl, orgDomainOfEmail, registrableDomain } from "@/lib/utils";
import type { Contact, Outreach } from "@/lib/types";

export interface ConversationMessage {
  id: string;
  fromName: string;
  fromEmail: string;
  to: string;
  date: string; // ISO
  /** Reply text with quoted history and signatures stripped. */
  body: string;
  isFromUs: boolean;
  /** Out-of-office, bounce or other automated mail: not a person replying. */
  isAutomated: boolean;
  /** Role of the matching CRM contact, when the sender is one. */
  contactRole: string | null;
}

export interface ConversationThread {
  threadId: string;
  subject: string;
  /** How the thread was found: our own outreach thread, or a separate one. */
  origin: "outreach" | "contact" | "domain";
  messages: ConversationMessage[];
  /** Newest message from a person at the organization. */
  lastReplyAt: string;
  gmailUrl: string;
}

export type ConversationResult =
  | { kind: "ok"; threads: ConversationThread[]; mailbox: string | null }
  | { kind: "unavailable"; error: string };

// Enough to cover every contact at one organization without flooding Gmail.
const MAX_THREADS = 12;

function parseFrom(from: string): { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: from.trim(), email: from.trim().toLowerCase() };
}

function isBounceSender(from: string): boolean {
  const f = from.toLowerCase();
  return f.includes("mailer-daemon") || f.includes("postmaster");
}

/** Gmail search date (YYYY/MM/DD), a day early to absorb time zones. */
function gmailAfter(iso: string): string {
  const d = new Date(iso);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Read the live mailbox for every conversation where someone at this lead's
 * organization wrote back: our outreach threads, plus separate threads from a
 * contact or anyone at the org's domain since we first emailed them (the same
 * three ways the reply scanner matches). Threads with no human reply are left
 * out. Bodies are read for display only and never stored.
 */
export async function getLeadConversations(lead: {
  website: string | null;
  contacts: Contact[];
  outreach: Outreach[];
}): Promise<ConversationResult> {
  const sent = lead.outreach.filter((o) => o.status === "sent" && o.sent_at);
  if (sent.length === 0) return { kind: "ok", threads: [], mailbox: null };

  let client: Awaited<ReturnType<typeof getGmailClient>>;
  try {
    client = await getGmailClient();
  } catch (e) {
    return { kind: "unavailable", error: e instanceof Error ? e.message : "Gmail is not connected." };
  }
  const { gmail, conn } = client;
  const mailbox = conn.email?.toLowerCase() ?? null;

  const outreachThreads = new Set(
    sent.map((o) => o.gmail_thread_id).filter((t): t is string => Boolean(t)),
  );
  const contactByEmail = new Map<string, Contact>();
  for (const c of lead.contacts) {
    if (c.email) contactByEmail.set(c.email.trim().toLowerCase(), c);
  }
  const domains = new Set<string>();
  const site = registrableDomain(domainFromUrl(lead.website));
  if (site) domains.add(site);
  for (const email of contactByEmail.keys()) {
    const d = orgDomainOfEmail(email);
    if (d) domains.add(d);
  }

  const firstSent = sent
    .map((o) => o.sent_at as string)
    .sort((a, b) => a.localeCompare(b))[0];
  const senders = [...domains, ...contactByEmail.keys()];

  try {
    const threadIds = new Set(outreachThreads);
    if (senders.length > 0) {
      const list = await gmail.users.messages.list({
        userId: "me",
        q: `from:(${senders.join(" OR ")}) after:${gmailAfter(firstSent)} -in:spam -in:trash`,
        maxResults: 50,
      });
      for (const m of list.data.messages ?? []) {
        if (m.threadId) threadIds.add(m.threadId);
      }
    }

    const fetched = await Promise.all(
      [...threadIds].slice(0, MAX_THREADS * 2).map(async (threadId) => {
        try {
          const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
          return res.data;
        } catch {
          return null; // deleted or moved out of this mailbox
        }
      }),
    );

    const threads: ConversationThread[] = [];
    for (const t of fetched) {
      if (!t?.id) continue;
      let subject = "";
      const messages: ConversationMessage[] = [];
      for (const m of t.messages ?? []) {
        if (!m.id) continue;
        const headers = m.payload?.headers ?? [];
        const header = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
        subject ||= header("subject");
        const from = header("from");
        const { name, email } = parseFrom(from);
        const labels = m.labelIds ?? [];
        const isFromUs =
          labels.includes("SENT") || (mailbox !== null && email === mailbox);
        const raw = extractBody(m.payload ?? undefined);
        const body = cleanBody(raw) || raw.trim().slice(0, 2000);
        messages.push({
          id: m.id,
          fromName: name,
          fromEmail: email,
          to: header("to"),
          date: m.internalDate
            ? new Date(Number(m.internalDate)).toISOString()
            : new Date(0).toISOString(),
          body,
          isFromUs,
          isAutomated:
            !isFromUs && (isBounceSender(from) || looksLikeAutoReply(header)),
          contactRole: contactByEmail.get(email)?.role ?? null,
        });
      }
      messages.sort((a, b) => a.date.localeCompare(b.date));
      // Cheryl often answers from her personal address; same display name as
      // our sent mail means it's still us, not the organization.
      const ourNames = new Set(
        messages.filter((m) => m.isFromUs).map((m) => m.fromName.toLowerCase()),
      );
      for (const m of messages) {
        if (!m.isFromUs && ourNames.has(m.fromName.toLowerCase())) {
          m.isFromUs = true;
          m.isAutomated = false;
        }
      }

      const replies = messages.filter((m) => !m.isFromUs && !m.isAutomated);
      if (replies.length === 0) continue;
      // A separate thread only counts if someone at the org actually wrote it.
      const fromOrg = replies.some(
        (m) =>
          contactByEmail.has(m.fromEmail) ||
          domains.has(orgDomainOfEmail(m.fromEmail) ?? ""),
      );
      const origin: ConversationThread["origin"] = outreachThreads.has(t.id)
        ? "outreach"
        : replies.some((m) => contactByEmail.has(m.fromEmail))
          ? "contact"
          : "domain";
      if (origin !== "outreach" && !fromOrg) continue;

      threads.push({
        threadId: t.id,
        subject: subject || "(no subject)",
        origin,
        messages,
        lastReplyAt: replies[replies.length - 1].date,
        gmailUrl: `https://mail.google.com/mail/u/${
          mailbox ? `?authuser=${encodeURIComponent(mailbox)}` : "0/"
        }#all/${t.id}`,
      });
    }

    threads.sort((a, b) => b.lastReplyAt.localeCompare(a.lastReplyAt));
    return { kind: "ok", threads: threads.slice(0, MAX_THREADS), mailbox };
  } catch (e) {
    return { kind: "unavailable", error: e instanceof Error ? e.message : "Could not read Gmail." };
  }
}
