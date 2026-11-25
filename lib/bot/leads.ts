// Lead lookup for the bot API: merge resolution, matching by email / domain /
// name, search results and the full lead view. Read-only.

import { getEnv } from "@/lib/env";
import { BotError, type Admin } from "@/lib/bot/http";
import {
  GENERIC_EMAIL_DOMAINS,
  domainFromUrl,
  mapWithConcurrency,
  normalizeName,
  orgDomainOfEmail,
  registrableDomain,
} from "@/lib/utils";
import { effectiveOrigin, firstSentChannel } from "@/lib/attribution";
import { engagementYearList } from "@/lib/engagements";
import type { Booking, Contact, Lead, LeadStatus, Outreach } from "@/lib/types";

// ---- Flake-side addresses ----------------------------------------------------

/**
 * Addresses on Jeff's side of a conversation: never turned into contacts and
 * never used to match a lead. Any @jeffflake.com address, Cheryl's Gmail, plus
 * BOT_OWN_ADDRESSES (comma-separated; e.g. Jeff's personal inbox).
 */
export function isOwnAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (e.endsWith("@jeffflake.com")) return true;
  if (e === "cherylflake@gmail.com") return true;
  const extra = (getEnv("BOT_OWN_ADDRESSES") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(e);
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Registrable org domain for a domain/host/URL, or null for personal mail. */
export function orgDomain(input: string | null | undefined): string | null {
  const host = domainFromUrl(input);
  const reg = registrableDomain(host);
  if (!reg || GENERIC_EMAIL_DOMAINS.has(reg)) return null;
  return reg;
}

// ---- Merge resolution --------------------------------------------------------

export interface ResolvedLead {
  lead: Lead;
  /** The id the caller asked for, when it was a merged duplicate. */
  mergedFrom: string | null;
}

/** Follow merged_into_id to the surviving lead. null when not found. */
export async function resolveLeadId(db: Admin, id: string): Promise<ResolvedLead | null> {
  let current = id;
  let mergedFrom: string | null = null;
  for (let hop = 0; hop < 10; hop += 1) {
    const { data, error } = await db.from("leads").select("*").eq("id", current).maybeSingle();
    if (error) {
      if (/invalid input syntax for type uuid/i.test(error.message)) return null;
      throw new Error(error.message);
    }
    if (!data) return null;
    const lead = data as Lead;
    if (lead.merged_into_id && lead.merged_into_id !== current) {
      mergedFrom ??= id;
      current = lead.merged_into_id;
      continue;
    }
    return { lead, mergedFrom };
  }
  throw new Error("merge chain too long");
}

/** Resolve or 404. */
export async function requireLead(db: Admin, id: string): Promise<ResolvedLead> {
  const r = await resolveLeadId(db, id);
  if (!r) throw new BotError(404, { error: "lead_not_found", lead_id: id }, `lead ${id} not found`);
  return r;
}

// ---- Matching ----------------------------------------------------------------

/** Lead ids whose contacts use exactly this address (case-insensitive). */
export async function leadIdsByContactEmail(db: Admin, email: string): Promise<string[]> {
  const { data, error } = await db
    .from("contacts")
    .select("lead_id")
    .ilike("email", escapeLike(email.trim()));
  if (error) throw new Error(error.message);
  return Array.from(new Set(((data ?? []) as Array<{ lead_id: string }>).map((r) => r.lead_id)));
}

/** Lead ids with correspondence from or to this address. */
export async function leadIdsByMessageEmail(db: Admin, email: string): Promise<string[]> {
  const e = email.trim().toLowerCase();
  const [from, to] = await Promise.all([
    db.from("lead_messages").select("lead_id").eq("from_email", e).limit(200),
    db.from("lead_messages").select("lead_id").contains("to_emails", [e]).limit(200),
  ]);
  const ids = new Set<string>();
  for (const r of [...((from.data ?? []) as Array<{ lead_id: string }>), ...((to.data ?? []) as Array<{ lead_id: string }>)]) {
    ids.add(r.lead_id);
  }
  return Array.from(ids);
}

/**
 * Lead ids for an organization domain: the lead's website host or any
 * contact address at that registrable domain (subdomains included). Personal
 * providers (gmail.com, ...) never match.
 */
export async function leadIdsByDomain(db: Admin, domain: string): Promise<string[]> {
  const reg = orgDomain(domain);
  if (!reg) return [];
  const like = escapeLike(reg);
  const [sites, contacts] = await Promise.all([
    db.from("leads").select("id, website").ilike("website", `%${like}%`).limit(500),
    db
      .from("contacts")
      .select("lead_id, email")
      .or(`email.ilike.%@${like},email.ilike.%.${like}`)
      .limit(1000),
  ]);
  if (sites.error) throw new Error(sites.error.message);
  if (contacts.error) throw new Error(contacts.error.message);
  const ids = new Set<string>();
  for (const r of (sites.data ?? []) as Array<{ id: string; website: string | null }>) {
    if (orgDomain(r.website) === reg) ids.add(r.id);
  }
  for (const r of (contacts.data ?? []) as Array<{ lead_id: string; email: string | null }>) {
    if (orgDomainOfEmail(r.email) === reg) ids.add(r.lead_id);
  }
  return Array.from(ids);
}

export async function leadIdsByExactName(db: Admin, name: string): Promise<string[]> {
  const key = normalizeName(name);
  if (!key) return [];
  const { data, error } = await db.from("leads").select("id").eq("name_normalized", key).limit(50);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

export async function leadIdsByNameContains(db: Admin, name: string, limit: number): Promise<string[]> {
  const q = name.trim();
  if (!q) return [];
  const key = normalizeName(q);
  const [byName, byKey] = await Promise.all([
    db.from("leads").select("id").ilike("name", `%${escapeLike(q)}%`).limit(limit),
    key
      ? db.from("leads").select("id").ilike("name_normalized", `%${escapeLike(key)}%`).limit(limit)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const ids = new Set<string>();
  for (const r of [...((byName.data ?? []) as Array<{ id: string }>), ...((byKey.data ?? []) as Array<{ id: string }>)]) {
    ids.add(r.id);
  }
  return Array.from(ids);
}

export interface Candidate {
  id: string;
  name: string;
  status: LeadStatus;
  lastActivity: string;
}

/** Latest activity per lead: max of updated_at and its newest interaction. */
async function lastActivityFor(db: Admin, leads: Array<{ id: string; updated_at: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const l of leads) out.set(l.id, l.updated_at);
  if (leads.length === 0) return out;
  const { data } = await db
    .from("interactions")
    .select("lead_id, created_at")
    .in("lead_id", leads.map((l) => l.id))
    .order("created_at", { ascending: false })
    .limit(2000);
  for (const r of (data ?? []) as Array<{ lead_id: string; created_at: string }>) {
    const cur = out.get(r.lead_id);
    if (!cur || r.created_at > cur) out.set(r.lead_id, r.created_at);
  }
  return out;
}

/**
 * Resolve candidate ids to surviving leads, dedupe, and rank: not junk
 * first, then most recent activity. Merged leads never appear (they resolve
 * to their target).
 */
export async function rankCandidates(db: Admin, ids: string[]): Promise<Candidate[]> {
  const survivors = new Map<string, Lead>();
  await mapWithConcurrency(Array.from(new Set(ids)).slice(0, 60), 6, async (id) => {
    const r = await resolveLeadId(db, id);
    if (r) survivors.set(r.lead.id, r.lead);
  });
  const leads = Array.from(survivors.values());
  const activity = await lastActivityFor(db, leads);
  return leads
    .map((l) => ({ id: l.id, name: l.name, status: l.status, lastActivity: activity.get(l.id) ?? l.updated_at }))
    .sort((a, b) => {
      const junk = Number(a.status === "junk") - Number(b.status === "junk");
      if (junk !== 0) return junk;
      return b.lastActivity.localeCompare(a.lastActivity);
    });
}

// ---- Views -------------------------------------------------------------------

export interface LeadSummary {
  id: string;
  name: string;
  website: string | null;
  status: LeadStatus;
  kind: string;
  inquiry_type: string | null;
  merged_into_id: string | null;
  resolved_lead_id: string;
  contacts: Array<{ name: string | null; email: string | null; role: string | null }>;
  last_activity: string;
  engagement_years: number[];
}

/** Search-result rows for the given lead ids (as stored; merges reported). */
export async function summarizeLeads(db: Admin, ids: string[]): Promise<LeadSummary[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from("leads")
    .select("*, contacts(name, email, role), bookings(event_year, outcome)")
    .in("id", ids);
  if (error) throw new Error(error.message);
  type Row = Lead & {
    contacts: Array<{ name: string | null; email: string | null; role: string | null }>;
    bookings: Array<Pick<Booking, "event_year" | "outcome">>;
  };
  const rows = (data ?? []) as unknown as Row[];
  const activity = await lastActivityFor(db, rows);
  const resolved = new Map<string, string>();
  await mapWithConcurrency(rows.filter((r) => r.merged_into_id), 4, async (r) => {
    const t = await resolveLeadId(db, r.id);
    if (t) resolved.set(r.id, t.lead.id);
  });
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      website: r.website,
      status: r.status,
      kind: r.kind ?? "speaking",
      inquiry_type: r.inquiry_type ?? null,
      merged_into_id: r.merged_into_id ?? null,
      resolved_lead_id: resolved.get(r.id) ?? r.id,
      contacts: (r.contacts ?? []).map((c) => ({ name: c.name, email: c.email, role: c.role })),
      last_activity: activity.get(r.id) ?? r.updated_at,
      engagement_years: engagementYearList(r.bookings),
    }))
    .sort((a, b) => b.last_activity.localeCompare(a.last_activity));
}

/** Everything the bot needs about one (resolved) lead. */
export async function fullLeadView(db: Admin, id: string, opts: { bodies: boolean }) {
  const { lead, mergedFrom } = await requireLead(db, id);
  const msgCols = opts.bodies
    ? "*"
    : "id, lead_id, contact_id, outreach_id, direction, from_email, from_name, to_emails, cc_emails, sent_at, subject, snippet, source_inbox, gmail_message_id, gmail_thread_id, rfc822_message_id, created_by, created_at";
  const [contacts, outreach, bookings, messages, interactions] = await Promise.all([
    db.from("contacts").select("*").eq("lead_id", lead.id).order("created_at", { ascending: true }),
    db
      .from("outreach")
      .select("id, contact_id, status, sent_via, sent_at, subject, gmail_message_id, gmail_thread_id, replied_at, bounced_at, sequence_step, created_at")
      .eq("lead_id", lead.id)
      .order("created_at", { ascending: true }),
    db.from("bookings").select("*").eq("lead_id", lead.id).order("event_year", { ascending: true, nullsFirst: true }),
    db.from("lead_messages").select(msgCols).eq("lead_id", lead.id).order("sent_at", { ascending: false }).limit(200),
    db.from("interactions").select("*").eq("lead_id", lead.id).order("created_at", { ascending: false }).limit(50),
  ]);
  for (const r of [contacts, outreach, bookings, messages, interactions]) {
    if (r.error) throw new Error(r.error.message);
  }
  const out = (outreach.data ?? []) as unknown as Array<Pick<Outreach, "status" | "sent_at" | "sent_via">>;
  const origin = effectiveOrigin(lead, firstSentChannel(out));
  const books = (bookings.data ?? []) as Booking[];
  return {
    lead: {
      id: lead.id,
      name: lead.name,
      type: lead.type,
      website: lead.website,
      description: lead.description,
      location_country: lead.location_country,
      location_region: lead.location_region,
      source: lead.source,
      status: lead.status,
      kind: lead.kind ?? "speaking",
      inquiry_type: lead.inquiry_type ?? null,
      revisit_on: lead.revisit_on,
      revisit_note: lead.revisit_note ?? null,
      attribution_override: lead.attribution_override ?? null,
      attribution_override_reason: lead.attribution_override_reason ?? null,
      attribution_override_by: lead.attribution_override_by ?? null,
      attribution_override_at: lead.attribution_override_at ?? null,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
    },
    merged_from: mergedFrom
      ? { lead_id: mergedFrom, note: `Lead ${mergedFrom} was merged into ${lead.id}; showing the surviving lead.` }
      : null,
    contacts: ((contacts.data ?? []) as Contact[]).map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      role: c.role,
      phone: c.phone ?? null,
      contact_status: c.contact_status,
      ooo_until: c.ooo_until ?? null,
      ooo_reason: c.ooo_reason ?? null,
      referred_by_contact_id: c.referred_by_contact_id ?? null,
      created_at: c.created_at,
    })),
    messages: messages.data ?? [],
    outreach: (outreach.data ?? []).filter((o) => (o as { status: string }).status === "sent"),
    engagements: books,
    interactions: interactions.data ?? [],
    engagement_years: engagementYearList(books),
    counts_as_app: origin.via === "app",
    origin: { via: origin.via, computed: origin.computed, overridden: origin.overridden },
  };
}
