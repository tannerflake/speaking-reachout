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
import { organizationSearchPhrases } from "@/lib/outreach/orgName";

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
 *   4. Live mailbox check by NAME: any mail from someone else that names the
 *      organization ("American Council of Engineering Companies"). A booking
 *      made through a speakers bureau lives only in threads with the bureau,
 *      so the org's own domain never appears.
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
  | "gmail_outbound"
  | "gmail_mention";

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
  /** Organization names the mailbox was searched for. */
  names: string[];
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
  "cant_pay",
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
  return orgMembers(await loadOrgSnapshot(db), leadId, extraEmails);
}

interface OrgSnapshot {
  leads: LeadRow[];
  contacts: ContactRow[];
  domainsByLead: Map<string, Set<string>>;
}

/**
 * Every row of a query, page by page. PostgREST silently stops at 1,000 rows,
 * and a guard that only sees the first 1,000 contacts fails OPEN.
 */
async function selectAll<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: () => any,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query()
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return rows;
  }
}

async function loadOrgSnapshot(db: Db): Promise<OrgSnapshot> {
  const [leads, contacts] = await Promise.all([
    selectAll<LeadRow>(() =>
      db.from("leads").select("id, name, name_normalized, status, website"),
    ),
    selectAll<ContactRow>(() => db.from("contacts").select("id, lead_id, email")),
  ]);

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
  return { leads, contacts, domainsByLead };
}

function orgMembers(
  snap: OrgSnapshot,
  leadId: string,
  extraEmails: Array<string | null | undefined> = [],
): { lead: LeadRow; domains: Set<string>; members: LeadRow[] } {
  const { leads, domainsByLead } = snap;
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) throw new Error("Lead not found.");

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

const SENT_OUTREACH_SELECT =
  "id, lead_id, status, sent_via, sent_at, replied_at, gmail_thread_id, contact:contacts(email, name)";

/** CRM conflicts (steps 1 and 2 of the guard) for a resolved organization. */
function crmConflicts(
  leadId: string,
  members: LeadRow[],
  sentOutreach: OutreachRow[],
): EngagementConflict[] {
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
  const memberIds = new Set(members.map((m) => m.id));
  const outreach = sentOutreach
    .filter((o) => memberIds.has(o.lead_id))
    .map((o) => ({ ...o, contact: one(o.contact) }));
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

  return conflicts;
}

/**
 * CRM-only guard verdict for many leads at once (one snapshot, no mailbox):
 * the reason each blocked lead would be refused at drafting or queueing.
 * The Leads list uses it so a blocked lead reads as blocked instead of
 * looking like an unfinished lead that every bulk run retries.
 */
export async function crmBlockReasons(
  db: Db,
  leadIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (leadIds.length === 0) return out;
  const [snap, sent] = await Promise.all([
    loadOrgSnapshot(db),
    selectAll<OutreachRow>(() =>
      db.from("outreach").select(SENT_OUTREACH_SELECT).eq("status", "sent"),
    ),
  ]);
  for (const id of leadIds) {
    if (!snap.leads.some((l) => l.id === id)) continue;
    const { members, domains } = orgMembers(snap, id);
    const conflicts = crmConflicts(id, members, sent);
    if (conflicts.length === 0) continue;
    out.set(
      id,
      summarizeConflicts({
        blocked: true,
        conflicts,
        siblings: [],
        domains: [...domains],
        names: [],
        gmailChecked: false,
      }),
    );
  }
  return out;
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

  // --- 1 & 2. CRM: statuses, replies and hand-sent outreach in the org ----
  const { data: outreachData, error: outreachErr } = await db
    .from("outreach")
    .select(SENT_OUTREACH_SELECT)
    .in("lead_id", memberIds)
    .eq("status", "sent");
  if (outreachErr) throw new Error(outreachErr.message);
  const conflicts = crmConflicts(
    leadId,
    members,
    (outreachData ?? []) as unknown as OutreachRow[],
  );

  // --- 3. Live mailbox -----------------------------------------------------
  const names = [
    ...new Set(members.flatMap((m) => organizationSearchPhrases(m.name))),
  ];
  let gmailChecked = false;
  if (!opts.skipGmail && (domains.size > 0 || names.length > 0)) {
    // Every thread this app ever started, CRM-wide, so an app send to the
    // same domain from any lead is recognized as ours rather than as a
    // hand-written thread.
    const appRows = await selectAll<unknown>(() =>
      db
        .from("outreach")
        .select("id, lead_id, gmail_thread_id, subject, contact:contacts(email)")
        .eq("sent_via", "app")
        .eq("status", "sent"),
    );
    const appSends: AppSends = { threads: new Set(), recipients: new Set() };
    // Subjects of what this app sent to this org: a forward or reply of our
    // own pitch names the org too, and isn't a sign of another conversation.
    const orgSubjects = new Set<string>();
    for (const r of (appRows ?? []) as unknown as Array<{
      lead_id: string;
      gmail_thread_id: string | null;
      subject: string;
      contact: { email: string | null } | { email: string | null }[] | null;
    }>) {
      if (r.gmail_thread_id) appSends.threads.add(r.gmail_thread_id);
      const email = one(r.contact)?.email?.toLowerCase();
      if (email) appSends.recipients.add(recipientKey(email, r.subject));
      if (memberIds.includes(r.lead_id)) orgSubjects.add(baseSubject(r.subject));
    }
    for (const domain of domains) {
      const found = await gmailConflictsForDomain(domain, appSends);
      conflicts.push(...found);
    }
    if (names.length > 0) {
      conflicts.push(
        ...(await gmailConflictsForNames(names, domains, appSends, orgSubjects)),
      );
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
    names,
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

/** "Re: Fwd: April Conference" -> "april conference". */
function baseSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
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

const SPEAKING_TERMS =
  "speak speaking speaker speakers speech keynote remarks lecture engagement honorarium booking booked offer contract";

/**
 * Search the mailbox for mail that names the organization, sent by anyone
 * other than this mailbox: a speakers bureau's offer, an event planner on a
 * personal address, a colleague's forward. The org's own domain is covered by
 * gmailConflictsForDomain; app threads, auto-replies and forwards of our own
 * pitch are skipped. One list call, metadata fetched only for candidates.
 */
async function gmailConflictsForNames(
  names: string[],
  domains: Set<string>,
  appSends: AppSends,
  orgSubjects: Set<string>,
): Promise<EngagementConflict[]> {
  const cacheKey = `names|${names.join("|")}|${appSends.threads.size}|${orgSubjects.size}`;
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

  const quoted = names.map((n) => `"${n.replace(/"/g, "")}"`).join(" ");
  // Only mail about a speaking engagement counts: a newsletter that happens
  // to mention "UCLA" is not a conversation about booking Jeff there.
  const q = `{${quoted}} {${SPEAKING_TERMS}} -from:me -category:promotions -category:social newer_than:${GMAIL_LOOKBACK_DAYS}d -in:spam -in:trash`;
  const conflicts: EngagementConflict[] = [];

  try {
    const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 25 });
    for (const msg of list.data.messages ?? []) {
      if (!msg.id || (msg.threadId && appSends.threads.has(msg.threadId))) continue;
      const res = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      });
      const h = res.data.payload?.headers ?? [];
      const get = (n: string) =>
        h.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
      const from = get("From");
      const subject = get("Subject");
      if (isAutomatedMessage(from, subject)) continue;
      if (orgSubjects.has(baseSubject(subject))) continue;
      const fromDomain = orgDomainOfEmail(addressesIn(from)[0]);
      if (fromDomain && domains.has(fromDomain)) continue; // reported by domain
      const text = `${subject} ${res.data.snippet ?? ""}`.toLowerCase();
      const named = names.find((n) => text.includes(n.toLowerCase()));
      const date = res.data.internalDate
        ? fmtDate(new Date(Number(res.data.internalDate)).toISOString())
        : "";
      conflicts.push({
        kind: "gmail_mention",
        leadId: null,
        leadName: null,
        detail: `The mailbox has mail from ${from} that mentions ${
          named ? `"${named}"` : `this organization (${names.map((n) => `"${n}"`).join(" or ")})`
        }: "${subject}"${date ? ` on ${date}` : ""}. It may be a booking through a speakers bureau or a contact outside the org's own email.`,
      });
      break;
    }
  } catch (e) {
    throw new EngagementGuardUnavailableError(
      e instanceof Error
        ? `Could not search the mailbox for this organization's name: ${e.message}`
        : "Could not search the mailbox for this organization's name.",
    );
  }

  gmailCache.set(cacheKey, { at: Date.now(), conflicts });
  return conflicts;
}
