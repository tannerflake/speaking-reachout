import type { SupabaseClient } from "@supabase/supabase-js";
import { getGmailClient } from "@/lib/gmail/send";
import {
  domainFromUrl,
  normalizeName,
  orgDomainOfEmail,
  registrableDomain,
  statusLabel,
} from "@/lib/utils";
import type { LeadStatus } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * ENGAGEMENT GUARD
 *
 * Never send net-new outreach to an organization we are already talking to.
 *
 * The CRM can hold the same organization under several leads (a discovered
 * "Distinguished Lecture Series at X" next to an imported "X University"), and
 * conversations can live only in the mailbox (Jeff emails a school by hand).
 * So the guard resolves the ORGANIZATION, not the lead row:
 *
 *   1. Same org = same registrable domain (website or any contact email) or a
 *      normalized name that contains / is contained by this lead's name.
 *   2. CRM conflicts across every lead in that org: a status that implies a
 *      human conversation, a recorded reply, or outreach sent by hand.
 *   3. Live mailbox check: any inbound mail from the domain, or any outbound
 *      mail to it that this app did not send, within the last year.
 *
 * The guard FAILS CLOSED: if the mailbox can't be checked, nothing is sent.
 * Callers may skip the mailbox step only for advisory checks (drafting, queue
 * preflight); the actual send path always runs the full check.
 */

export class EngagementGuardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngagementGuardUnavailableError";
  }
}

export type ConflictKind =
  | "crm_status"
  | "crm_reply"
  | "crm_manual_outreach"
  | "gmail_inbound"
  | "gmail_outbound";

export interface EngagementConflict {
  kind: ConflictKind;
  /** The CRM lead involved: this lead or a sibling for the same org. */
  leadId: string | null;
  leadName: string | null;
  detail: string;
}

export interface OrgSibling {
  id: string;
  name: string;
  status: LeadStatus;
}

export interface EngagementGuardResult {
  blocked: boolean;
  conflicts: EngagementConflict[];
  /** Other CRM leads resolved to the same organization (duplicates). */
  siblings: OrgSibling[];
  /** Domains the organization was identified by. */
  domains: string[];
  /** False when the caller skipped the live mailbox check. */
  gmailChecked: boolean;
}

/** Lead statuses that mean a human conversation has happened. */
export const ENGAGED_STATUSES: LeadStatus[] = [
  "interested",
  "booked",
  "closed",
  "closed_not_me",
  "not_interested",
];

/** How far back the mailbox is searched for an existing conversation. */
export const GMAIL_LOOKBACK_DAYS = 365;

const MIN_NAME_KEY = 10;

interface LeadRow {
  id: string;
  name: string;
  name_normalized: string | null;
  status: LeadStatus;
  website: string | null;
}
interface ContactRow {
  lead_id: string;
  email: string | null;
}
interface OutreachRow {
  id: string;
  lead_id: string;
  status: string;
  sent_via: string;
  sent_at: string | null;
  replied_at: string | null;
  gmail_thread_id: string | null;
  contact: { email: string | null; name: string | null } | { email: string | null; name: string | null }[] | null;
}

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Resolve the organization a lead belongs to: its domains and every other
 * lead that shares one (or whose name contains / is contained by this one).
 */
export async function resolveOrganization(
  db: Db,
  leadId: string,
  extraEmails: Array<string | null | undefined> = [],
): Promise<{ lead: LeadRow; domains: Set<string>; members: LeadRow[] }> {
  const [leadsRes, contactsRes] = await Promise.all([
    db.from("leads").select("id, name, name_normalized, status, website"),
    db.from("contacts").select("lead_id, email"),
  ]);
  if (leadsRes.error) throw new Error(leadsRes.error.message);
  if (contactsRes.error) throw new Error(contactsRes.error.message);

  const leads = (leadsRes.data ?? []) as LeadRow[];
  const contacts = (contactsRes.data ?? []) as ContactRow[];
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) throw new Error("Lead not found.");

  // Domains per lead: website + every contact's org email domain.
  const domainsByLead = new Map<string, Set<string>>();
  for (const l of leads) {
    const s = new Set<string>();
    const d = registrableDomain(domainFromUrl(l.website));
    if (d) s.add(d);
    domainsByLead.set(l.id, s);
  }
  for (const c of contacts) {
    const d = orgDomainOfEmail(c.email);
    if (d) domainsByLead.get(c.lead_id)?.add(d);
  }
  const domains = new Set(domainsByLead.get(leadId) ?? []);
  for (const e of extraEmails) {
    const d = orgDomainOfEmail(e);
    if (d) domains.add(d);
  }

  const key = lead.name_normalized ?? normalizeName(lead.name);
  const members: LeadRow[] = [lead];
  for (const other of leads) {
    if (other.id === leadId) continue;
    const otherDomains = domainsByLead.get(other.id) ?? new Set<string>();
    let same = [...otherDomains].some((d) => domains.has(d));
    if (!same) {
      const otherKey = other.name_normalized ?? normalizeName(other.name);
      const shorter = Math.min(key.length, otherKey.length);
      if (
        shorter >= MIN_NAME_KEY &&
        (key.includes(otherKey) || otherKey.includes(key))
      ) {
        same = true;
      }
    }
    if (same) members.push(other);
  }
  return { lead, domains, members };
}

/**
 * Run the engagement guard for a lead. Throws EngagementGuardUnavailableError
 * when the mailbox can't be consulted (callers must treat that as "do not
 * send"). Pass `contactEmail` for the recipient so its domain is included.
 */
export async function checkEngagementGuard(
  db: Db,
  leadId: string,
  opts: { contactEmail?: string | null; skipGmail?: boolean } = {},
): Promise<EngagementGuardResult> {
  const { lead, domains, members } = await resolveOrganization(db, leadId, [
    opts.contactEmail,
  ]);
  const memberIds = members.map((m) => m.id);
  const conflicts: EngagementConflict[] = [];

  // --- 1. CRM: status across every lead in the org ------------------------
  for (const m of members) {
    if (ENGAGED_STATUSES.includes(m.status)) {
      conflicts.push({
        kind: "crm_status",
        leadId: m.id,
        leadName: m.name,
        detail:
          m.id === leadId
            ? `This lead is already ${statusLabel(m.status)}.`
            : `"${m.name}" (same organization) is ${statusLabel(m.status)}.`,
      });
    }
  }

  // --- 2. CRM: replies and hand-sent outreach anywhere in the org ---------
  const { data: outreachData, error: outreachErr } = await db
    .from("outreach")
    .select(
      "id, lead_id, status, sent_via, sent_at, replied_at, gmail_thread_id, contact:contacts(email, name)",
    )
    .in("lead_id", memberIds)
    .eq("status", "sent");
  if (outreachErr) throw new Error(outreachErr.message);
  const outreach = ((outreachData ?? []) as unknown as OutreachRow[]).map((o) => ({
    ...o,
    contact: one(o.contact),
  }));
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? null;

  const repliedLeads = new Set<string>();
  const manualLeads = new Set<string>();
  for (const o of outreach) {
    if (o.replied_at && !repliedLeads.has(o.lead_id)) {
      repliedLeads.add(o.lead_id);
      conflicts.push({
        kind: "crm_reply",
        leadId: o.lead_id,
        leadName: nameOf(o.lead_id),
        detail: `${o.contact?.name || o.contact?.email || "A contact"} replied on ${fmtDate(o.replied_at)}${
          o.lead_id === leadId ? "" : ` (lead "${nameOf(o.lead_id)}")`
        }.`,
      });
    }
    if (o.sent_via === "gmail" && !manualLeads.has(o.lead_id)) {
      manualLeads.add(o.lead_id);
      conflicts.push({
        kind: "crm_manual_outreach",
        leadId: o.lead_id,
        leadName: nameOf(o.lead_id),
        detail: `Outreach was sent by hand from Gmail to ${o.contact?.email ?? "this organization"} on ${fmtDate(o.sent_at)}${
          o.lead_id === leadId ? "" : ` (lead "${nameOf(o.lead_id)}")`
        }; Jeff or Cheryl own that thread.`,
      });
    }
  }

  // --- 3. Live mailbox -----------------------------------------------------
  let gmailChecked = false;
  if (!opts.skipGmail && domains.size > 0) {
    // Every thread this app ever started, CRM-wide, so an app send to the
    // same domain from any lead is recognized as ours rather than as a
    // hand-written thread.
    const { data: appRows, error: appErr } = await db
      .from("outreach")
      .select("gmail_thread_id, subject, contact:contacts(email)")
      .eq("sent_via", "app")
      .eq("status", "sent");
    if (appErr) throw new Error(appErr.message);
    const appSends: AppSends = { threads: new Set(), recipients: new Set() };
    for (const r of (appRows ?? []) as unknown as Array<{
      gmail_thread_id: string | null;
      subject: string;
      contact: { email: string | null } | { email: string | null }[] | null;
    }>) {
      if (r.gmail_thread_id) appSends.threads.add(r.gmail_thread_id);
      const email = one(r.contact)?.email?.toLowerCase();
      if (email) appSends.recipients.add(recipientKey(email, r.subject));
    }
    for (const domain of domains) {
      const found = await gmailConflictsForDomain(domain, appSends);
      conflicts.push(...found);
    }
    gmailChecked = true;
  }

  const siblings: OrgSibling[] = members
    .filter((m) => m.id !== leadId)
    .map((m) => ({ id: m.id, name: m.name, status: m.status }));

  return {
    blocked: conflicts.length > 0,
    conflicts,
    siblings,
    domains: [...domains],
    gmailChecked,
  };
}

/** One-line reason suitable for an error field or activity note. */
export function summarizeConflicts(result: EngagementGuardResult): string {
  if (result.conflicts.length === 0) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of result.conflicts) {
    if (seen.has(c.detail)) continue;
    seen.add(c.detail);
    lines.push(c.detail);
  }
  return `Already in conversation with this organization. ${lines.join(" ")}`;
}

// --- Gmail -------------------------------------------------------------------

const AUTOMATED_SUBJECT =
  /^\s*(re:\s*)?(automatic reply|auto-?reply|autoreply|out of (the )?office|ooo\b|away from (the )?office|on leave|delivery status|undeliverable|undelivered|mail delivery|delivery has failed|returned mail|failure notice|return code)/i;
const AUTOMATED_FROM = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)/i;

/** Out-of-office replies and bounces are not a human conversation. */
export function isAutomatedMessage(from: string, subject: string): boolean {
  return AUTOMATED_FROM.test(from) || AUTOMATED_SUBJECT.test(subject);
}

interface GmailCacheEntry {
  at: number;
  conflicts: EngagementConflict[];
}
const GMAIL_CACHE_TTL_MS = 2 * 60 * 1000;
const gmailCache = new Map<string, GmailCacheEntry>();

/**
 * Search the connected mailbox for an existing conversation with a domain.
 * Two cheap list calls per domain (inbound, then outbound-not-ours), with a
 * metadata fetch only when something is found. Cached briefly so a queue
 * drain sending to several people at one org doesn't repeat the work.
 */
/**
 * What this app has sent, for telling our mail apart from hand-written mail:
 * by Gmail thread id, and by recipient + subject as a fallback (a duplicate
 * copy in Sent, which has its own thread id, is still ours).
 */
interface AppSends {
  threads: Set<string>;
  recipients: Set<string>;
}

function recipientKey(email: string, subject: string): string {
  return `${email.trim().toLowerCase()}|${subject.trim().toLowerCase()}`;
}

/** Every address in a To/Cc header: "A <a@x.edu>, b@x.edu" -> ["a@x.edu", "b@x.edu"]. */
function addressesIn(header: string): string[] {
  return (header.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? []).map((a) => a.toLowerCase());
}

async function gmailConflictsForDomain(
  domain: string,
  appSends: AppSends,
): Promise<EngagementConflict[]> {
  const cacheKey = `${domain}|${appSends.threads.size}|${appSends.recipients.size}`;
  const cached = gmailCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GMAIL_CACHE_TTL_MS) return cached.conflicts;

  let gmail: Awaited<ReturnType<typeof getGmailClient>>["gmail"];
  try {
    ({ gmail } = await getGmailClient());
  } catch (e) {
    throw new EngagementGuardUnavailableError(
      e instanceof Error ? e.message : "Gmail is not available.",
    );
  }

  const conflicts: EngagementConflict[] = [];
  const window = `newer_than:${GMAIL_LOOKBACK_DAYS}d -in:spam -in:trash`;

  const header = (
    headers: Array<{ name?: string | null; value?: string | null }> | undefined,
    name: string,
  ) =>
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  async function describe(id: string): Promise<{ from: string; to: string; subject: string; date: string }> {
    const res = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Date"],
    });
    const h = res.data.payload?.headers ?? undefined;
    return {
      from: header(h, "From"),
      to: header(h, "To"),
      subject: header(h, "Subject"),
      date: res.data.internalDate
        ? fmtDate(new Date(Number(res.data.internalDate)).toISOString())
        : "",
    };
  }

  try {
    // Inbound: a person at the domain wrote to us. Bounces and auto-replies
    // (out of office, "automatic reply") are not a conversation, so walk the
    // newest messages until a human one turns up.
    const inbound = await gmail.users.messages.list({
      userId: "me",
      q: `from:${domain} -from:mailer-daemon -from:postmaster ${window}`,
      maxResults: 20,
    });
    for (const msg of inbound.data.messages ?? []) {
      if (!msg.id) continue;
      const m = await describe(msg.id);
      if (isAutomatedMessage(m.from, m.subject)) continue;
      conflicts.push({
        kind: "gmail_inbound",
        leadId: null,
        leadName: null,
        detail: `The mailbox has a reply from @${domain}: "${m.subject}" from ${m.from}${m.date ? ` on ${m.date}` : ""}.`,
      });
      break;
    }

    // Outbound: we wrote to the domain in a thread this app didn't start,
    // i.e. Jeff or Cheryl reached out by hand.
    const outbound = await gmail.users.messages.list({
      userId: "me",
      q: `{to:${domain} cc:${domain}} in:sent ${window}`,
      maxResults: 100,
    });
    const candidates = (outbound.data.messages ?? []).filter(
      (m) => m.id && m.threadId && !appSends.threads.has(m.threadId),
    );
    // A thread we don't know could still be ours (a duplicated Sent copy), so
    // confirm by recipient + subject before calling it hand-written.
    let foreignCount = 0;
    let first: { subject: string; to: string; date: string } | null = null;
    for (const m of candidates) {
      const d = await describe(m.id as string);
      const ours = addressesIn(d.to).some((a) =>
        appSends.recipients.has(recipientKey(a, d.subject)),
      );
      if (ours) continue;
      foreignCount += 1;
      if (!first) first = d;
    }
    if (first) {
      conflicts.push({
        kind: "gmail_outbound",
        leadId: null,
        leadName: null,
        detail: `The mailbox already has outreach to @${domain} that this app did not send: "${first.subject}" to ${first.to}${first.date ? ` on ${first.date}` : ""}${
          foreignCount > 1 ? ` (and ${foreignCount - 1} more)` : ""
        }.`,
      });
    }
  } catch (e) {
    throw new EngagementGuardUnavailableError(
      e instanceof Error
        ? `Could not check the mailbox for @${domain}: ${e.message}`
        : `Could not check the mailbox for @${domain}.`,
    );
  }

  gmailCache.set(cacheKey, { at: Date.now(), conflicts });
  return conflicts;
}
