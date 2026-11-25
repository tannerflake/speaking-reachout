// Request shapes for /api/bot/v1 and their hand-written validation.

import { BotError, Checker } from "@/lib/bot/http";
import {
  BOOKING_OUTCOMES,
  LEAD_STATUSES,
  type AttributionOverride,
  type BookingOutcome,
  type InquiryType,
  type LeadKind,
  type LeadStatus,
  type LeadType,
  type MessageDirection,
} from "@/lib/types";

export const MAX_MESSAGES = 200;
export const MAX_CONTACTS = 50;
export const MAX_ENGAGEMENTS = 100;
export const MAX_BODY_CHARS = 100_000;

export interface MessageIn {
  direction: MessageDirection;
  from_email: string;
  from_name: string | null;
  to: string[];
  cc: string[];
  sent_at: string;
  subject: string | null;
  body: string | null;
  snippet: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  rfc822_message_id: string | null;
  source_inbox: string;
  sent_via: "gmail" | "app";
}

export interface EngagementIn {
  id?: string;
  event_name?: string;
  event_date?: string | null;
  event_end_date?: string | null;
  event_year?: number | null;
  fee?: number | null;
  topic?: string | null;
  location?: string | null;
  outcome?: BookingOutcome | null;
  is_recurring?: boolean;
  notes?: string | null;
}

export interface ContactIn {
  email: string;
  name?: string | null;
  role?: string | null;
  phone?: string | null;
  ooo_until?: string | null;
  ooo_reason?: string | null;
  referred_by_email?: string;
}

export interface LeadFieldsIn {
  name?: string;
  website?: string | null;
  type?: LeadType;
  description?: string | null;
  location_country?: string | null;
  location_region?: string | null;
  status?: LeadStatus;
  status_reason?: string | null;
  revisit_on?: string | null;
  revisit_note?: string | null;
  attribution_override?: AttributionOverride | null;
  attribution_override_reason?: string | null;
  kind?: LeadKind;
  inquiry_type?: InquiryType | null;
}

export interface UpsertIn {
  source_inbox: string;
  dry_run: boolean;
  match: { lead_id?: string; domain?: string; email?: string };
  lead: LeadFieldsIn;
  contacts: ContactIn[];
  messages: MessageIn[];
  engagements: EngagementIn[];
  note: string | null;
}

/** 413 when a payload is over the per-call limits. */
export function checkLimits(body: Record<string, unknown>): void {
  const len = (k: string) => (Array.isArray(body[k]) ? (body[k] as unknown[]).length : 0);
  if (len("messages") > MAX_MESSAGES) {
    throw new BotError(413, { error: "too_many_messages", max: MAX_MESSAGES }, `413: ${len("messages")} messages`);
  }
  if (len("contacts") > MAX_CONTACTS) {
    throw new BotError(413, { error: "too_many_contacts", max: MAX_CONTACTS }, `413: ${len("contacts")} contacts`);
  }
  if (len("engagements") > MAX_ENGAGEMENTS) {
    throw new BotError(413, { error: "too_many_engagements", max: MAX_ENGAGEMENTS }, `413: ${len("engagements")} engagements`);
  }
}

export function requireBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BotError(400, { error: "validation_failed", fields: [{ path: "$", message: "body must be a JSON object" }] }, "body not an object");
  }
  return raw as Record<string, unknown>;
}

export function parseSourceInbox(c: Checker, v: unknown): string {
  return c.email(v, "source_inbox", { required: true }) ?? "";
}

export function parseMessages(c: Checker, v: unknown, sourceInbox: string, path = "messages"): MessageIn[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    c.err(path, "must be an array");
    return [];
  }
  const out: MessageIn[] = [];
  v.forEach((raw, i) => {
    const p = `${path}[${i}]`;
    const m = c.obj(raw, p);
    if (!m) return;
    const direction = c.oneOf(m.direction, `${p}.direction`, ["inbound", "outbound"] as const, { required: true });
    const from = c.email(m.from_email, `${p}.from_email`, { required: true });
    const to = c.emails(m.to, `${p}.to`, { required: true });
    const cc = c.emails(m.cc, `${p}.cc`) ?? [];
    let sentAt: string | undefined;
    if (typeof m.sent_at !== "string" || Number.isNaN(new Date(m.sent_at).getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(m.sent_at)) {
      c.err(`${p}.sent_at`, "required ISO datetime, e.g. 2026-11-20T15:04:00Z");
    } else {
      sentAt = new Date(m.sent_at).toISOString();
    }
    const body = typeof m.body === "string" ? m.body.slice(0, MAX_BODY_CHARS) : null;
    if (m.body !== undefined && m.body !== null && typeof m.body !== "string") c.err(`${p}.body`, "must be a string");
    const msgInbox = m.source_inbox === undefined || m.source_inbox === null
      ? sourceInbox
      : c.email(m.source_inbox, `${p}.source_inbox`);
    const sentVia = c.oneOf(m.sent_via, `${p}.sent_via`, ["gmail", "app"] as const) ?? "gmail";
    const subject = c.str(m.subject, `${p}.subject`, { nullable: true, max: 2000 }) ?? null;
    const snippet = c.str(m.snippet, `${p}.snippet`, { nullable: true, max: 5000 }) ?? null;
    const fromName = c.str(m.from_name, `${p}.from_name`, { nullable: true, max: 300 }) ?? null;
    const gid = c.str(m.gmail_message_id, `${p}.gmail_message_id`, { nullable: true, max: 300 }) || null;
    const tid = c.str(m.gmail_thread_id, `${p}.gmail_thread_id`, { nullable: true, max: 300 }) || null;
    const rfc = c.str(m.rfc822_message_id, `${p}.rfc822_message_id`, { nullable: true, max: 1000 }) || null;
    if (!direction || !from || !to || !sentAt || !msgInbox) return;
    out.push({
      direction,
      from_email: from,
      from_name: fromName,
      to,
      cc,
      sent_at: sentAt,
      subject,
      body,
      snippet: snippet ?? (body ? body.replace(/\s+/g, " ").trim().slice(0, 240) : null),
      gmail_message_id: gid,
      gmail_thread_id: tid,
      rfc822_message_id: rfc,
      source_inbox: msgInbox,
      sent_via: sentVia,
    });
  });
  return out;
}

export function parseEngagements(c: Checker, v: unknown, path = "engagements"): EngagementIn[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    c.err(path, "must be an array");
    return [];
  }
  const out: EngagementIn[] = [];
  v.forEach((raw, i) => {
    const p = `${path}[${i}]`;
    const e = c.obj(raw, p);
    if (!e) return;
    const before = c.errors.length;
    const eng: EngagementIn = {};
    if (e.id !== undefined) {
      if (typeof e.id !== "string" || !/^[0-9a-f-]{36}$/i.test(e.id)) c.err(`${p}.id`, "must be a booking uuid");
      else eng.id = e.id;
    }
    const name = c.str(e.event_name, `${p}.event_name`, { max: 500 });
    if (name) eng.event_name = name;
    if (!eng.id && !name) c.err(`${p}.event_name`, "required when creating an engagement");
    const date = c.date(e.event_date, `${p}.event_date`, { nullable: true });
    if (date !== undefined) eng.event_date = date;
    const end = c.date(e.event_end_date, `${p}.event_end_date`, { nullable: true });
    if (end !== undefined) eng.event_end_date = end;
    const year = c.num(e.event_year, `${p}.event_year`, { int: true, nullable: true, min: 1990, max: 2100 });
    if (year !== undefined) eng.event_year = year;
    if (!eng.id && !date && year == null) c.err(`${p}.event_year`, "required when event_date is empty");
    if (date && year != null && Number(date.slice(0, 4)) !== year) {
      c.err(`${p}.event_year`, "does not match event_date");
    }
    const fee = c.num(e.fee, `${p}.fee`, { nullable: true, min: 0 });
    if (fee !== undefined) eng.fee = fee;
    for (const k of ["topic", "location", "notes"] as const) {
      const s = c.str(e[k], `${p}.${k}`, { nullable: true, max: 5000 });
      if (s !== undefined) eng[k] = s || null;
    }
    const outcome = c.oneOf(e.outcome, `${p}.outcome`, BOOKING_OUTCOMES, { nullable: true });
    if (outcome !== undefined) eng.outcome = outcome;
    const rec = c.bool(e.is_recurring, `${p}.is_recurring`);
    if (rec !== undefined) eng.is_recurring = rec;
    if (c.errors.length === before) out.push(eng);
  });
  return out;
}

export function parseContacts(c: Checker, v: unknown): ContactIn[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    c.err("contacts", "must be an array");
    return [];
  }
  const out: ContactIn[] = [];
  v.forEach((raw, i) => {
    const p = `contacts[${i}]`;
    const o = c.obj(raw, p);
    if (!o) return;
    const email = c.email(o.email, `${p}.email`, { required: true });
    const ct: ContactIn = { email: email ?? "" };
    for (const k of ["name", "role", "phone", "ooo_reason"] as const) {
      const s = c.str(o[k], `${p}.${k}`, { nullable: true, max: 500 });
      if (s !== undefined) ct[k] = s || null;
    }
    const ooo = c.date(o.ooo_until, `${p}.ooo_until`, { nullable: true });
    if (ooo !== undefined) ct.ooo_until = ooo;
    const ref = c.email(o.referred_by_email, `${p}.referred_by_email`);
    if (ref) ct.referred_by_email = ref;
    if (email) out.push(ct);
  });
  return out;
}

export function parseLeadFields(c: Checker, v: unknown): LeadFieldsIn {
  const o = c.obj(v, "lead", false) ?? {};
  const l: LeadFieldsIn = {};
  const name = c.str(o.name, "lead.name", { max: 300 });
  if (name) l.name = name;
  for (const k of ["website", "description", "location_country", "location_region", "status_reason", "revisit_note", "attribution_override_reason"] as const) {
    const s = c.str(o[k], `lead.${k}`, { nullable: true, max: 5000 });
    if (s !== undefined) l[k] = s || null;
  }
  const type = c.oneOf(o.type, "lead.type", ["event", "institution", "other"] as const);
  if (type) l.type = type;
  const status = c.oneOf(o.status, "lead.status", LEAD_STATUSES);
  if (status) l.status = status;
  const rv = c.date(o.revisit_on, "lead.revisit_on", { nullable: true });
  if (rv !== undefined) l.revisit_on = rv;
  const ao = c.oneOf(o.attribution_override, "lead.attribution_override", ["app", "not_app"] as const, { nullable: true });
  if (ao !== undefined) l.attribution_override = ao;
  if (ao && !l.attribution_override_reason) {
    c.err("lead.attribution_override_reason", "required when setting attribution_override");
  }
  const kind = c.oneOf(o.kind, "lead.kind", ["speaking", "inquiry"] as const);
  if (kind) l.kind = kind;
  const it = c.oneOf(o.inquiry_type, "lead.inquiry_type", ["press", "interview_student", "other"] as const, { nullable: true });
  if (it !== undefined) l.inquiry_type = it;
  return l;
}

export function parseUpsert(raw: unknown): UpsertIn {
  const body = requireBody(raw);
  checkLimits(body);
  const c = new Checker();
  const sourceInbox = parseSourceInbox(c, body.source_inbox);
  const dryRun = c.bool(body.dry_run, "dry_run") ?? false;
  const mo = c.obj(body.match, "match", false) ?? {};
  const match: UpsertIn["match"] = {};
  if (mo.lead_id !== undefined) {
    if (typeof mo.lead_id !== "string" || !/^[0-9a-f-]{36}$/i.test(mo.lead_id)) c.err("match.lead_id", "must be a uuid");
    else match.lead_id = mo.lead_id;
  }
  const md = c.str(mo.domain, "match.domain", { max: 300 });
  if (md) match.domain = md.toLowerCase();
  const me = c.email(mo.email, "match.email");
  if (me) match.email = me;
  const lead = parseLeadFields(c, body.lead);
  const contacts = parseContacts(c, body.contacts);
  const messages = parseMessages(c, body.messages, sourceInbox);
  const engagements = parseEngagements(c, body.engagements);
  const note = c.str(body.note, "note", { nullable: true, max: 5000 }) || null;
  c.fail();
  return { source_inbox: sourceInbox, dry_run: dryRun, match, lead, contacts, messages, engagements, note };
}
