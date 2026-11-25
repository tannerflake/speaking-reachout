// Write engine for the bot import API (/api/bot/v1).
//
// SAFETY RULES (enforced here, not just documented):
// - Nothing in this file sends, queues or drafts email, starts a follow-up
//   sequence, runs enrichment / contact finding / discovery, or calls Claude.
//   Status is written directly to the DB; the app's server actions are NOT
//   reused because some of them have side effects (drafting, sequences).
// - Outreach rows created here are status 'sent' (historical record of a
//   Gmail send) and never 'queued', so the send-queue tick never picks them
//   up, and no followup_sequences row is ever created for them, so the
//   follow-up runner never touches them either (both only act on 'queued'
//   outreach and on followup_sequences). They exist so the engagement guard
//   and attribution see the conversation. sent_via defaults to 'gmail', so
//   bot-logged mail does NOT count as "App (Tanner)" (Sent by).
// - Stopping follow-ups IS allowed (positive/terminal status change, or a
//   human reply newer than an active sequence); creating them is not.
// - Blocked leads are never unblocked by the bot. Status never changes
//   implicitly (e.g. from an inbound message); only lead.status or the status
//   endpoint change it.
// - Every write goes to the surviving lead (merged_into_id followed) and adds
//   an interactions row with actor 'bot:<name>' and source_inbox.
// - Messages are idempotent: duplicates by (source_inbox, gmail_message_id),
//   rfc822_message_id, or an outreach row with the same gmail_message_id are
//   skipped; unique violations (23505) count as duplicates. Re-sending the
//   same payload writes nothing new (bot_activity aside).
// - dry_run runs the same resolution and dedupe and writes nothing.

import { BotError, type Admin } from "@/lib/bot/http";
import {
  isOwnAddress,
  leadIdsByContactEmail,
  leadIdsByDomain,
  leadIdsByExactName,
  orgDomain,
  rankCandidates,
  requireLead,
  escapeLike,
} from "@/lib/bot/leads";
import type { ContactIn, EngagementIn, LeadFieldsIn, MessageIn, UpsertIn } from "@/lib/bot/schema";
import { stopFollowupsForOrganization, stopSequencesForLead } from "@/lib/followups/stop";
import { applyRevisitForReply } from "@/lib/gmail/replyScan";
import { isAutomatedMessage } from "@/lib/outreach/guard";
import { localDatePlus } from "@/lib/attribution";
import { looksLikeRealEmail, mapWithConcurrency, orgDomainOfEmail, statusLabel } from "@/lib/utils";
import type { Booking, Lead, LeadStatus } from "@/lib/types";

/** Status changes that end automated follow-ups for the lead. */
export const STOP_FOLLOWUP_STATUSES: LeadStatus[] = [
  "interested",
  "back_burner",
  "booked",
  "closed",
  "closed_not_me",
  "not_interested",
  "cant_pay",
  "junk",
  "blocked",
];

export interface ImportCtx {
  db: Admin;
  actor: string;
  botName: string;
  sourceInbox: string;
  dry: boolean;
  changes: string[];
  warnings: string[];
}

export function newCtx(db: Admin, actor: string, botName: string, sourceInbox: string, dry: boolean): ImportCtx {
  return { db, actor, botName, sourceInbox, dry, changes: [], warnings: [] };
}

function warn(ctx: ImportCtx, msg: string) {
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
}

async function interaction(
  ctx: ImportCtx,
  leadId: string,
  kind: "status_change" | "note" | "email_sent",
  detail: string,
  sourceInbox?: string,
): Promise<void> {
  if (ctx.dry) return;
  const { error } = await ctx.db.from("interactions").insert({
    lead_id: leadId,
    kind,
    detail,
    actor: ctx.actor,
    source_inbox: sourceInbox ?? ctx.sourceInbox,
  });
  if (error) throw new Error(`interactions insert: ${error.message}`);
}

const isUniqueViolation = (e: { code?: string } | null | undefined) => e?.code === "23505";

// ---- Lead resolution ---------------------------------------------------------

export interface Resolution {
  lead: Lead | null;
  matchedBy: "lead_id" | "email" | "domain" | "name" | null;
  ambiguous: Array<{ id: string; name: string; status: LeadStatus; last_activity: string }>;
  mergedFrom: string | null;
}

/**
 * match.lead_id -> exact contact email (contacts[], match.email, non-Flake
 * message addresses) -> domain (match.domain, website, non-generic contact
 * domains) -> exact normalized name. Several hits: not junk first, then most
 * recent activity; the others are reported as ambiguous_candidates.
 */
export async function resolveForUpsert(db: Admin, input: UpsertIn): Promise<Resolution> {
  if (input.match.lead_id) {
    const r = await requireLead(db, input.match.lead_id);
    return { lead: r.lead, matchedBy: "lead_id", ambiguous: [], mergedFrom: r.mergedFrom };
  }

  const emails = new Set<string>();
  for (const c of input.contacts) emails.add(c.email);
  if (input.match.email) emails.add(input.match.email);
  for (const m of input.messages) {
    for (const e of [m.from_email, ...m.to, ...m.cc]) emails.add(e);
  }
  const external = Array.from(emails).filter((e) => !isOwnAddress(e)).slice(0, 80);

  const pick = async (ids: string[], by: Resolution["matchedBy"]): Promise<Resolution | null> => {
    if (ids.length === 0) return null;
    const ranked = await rankCandidates(db, ids);
    if (ranked.length === 0) return null;
    const { lead } = await requireLead(db, ranked[0].id);
    return {
      lead,
      matchedBy: by,
      mergedFrom: null,
      ambiguous:
        ranked.length > 1
          ? ranked.slice(1).map((c) => ({ id: c.id, name: c.name, status: c.status, last_activity: c.lastActivity }))
          : [],
    };
  };

  const byEmail = (
    await mapWithConcurrency(external, 6, (e) => leadIdsByContactEmail(db, e))
  ).flat();
  const emailHit = await pick(byEmail, "email");
  if (emailHit) return emailHit;

  const domains = new Set<string>();
  if (input.match.domain) {
    const d = orgDomain(input.match.domain);
    if (d) domains.add(d);
  }
  const site = orgDomain(input.lead.website ?? null);
  if (site) domains.add(site);
  for (const c of input.contacts) {
    const d = orgDomainOfEmail(c.email);
    if (d && !isOwnAddress(c.email)) domains.add(d);
  }
  domains.delete("jeffflake.com");
  const byDomain = (await mapWithConcurrency(Array.from(domains), 4, (d) => leadIdsByDomain(db, d))).flat();
  const domainHit = await pick(byDomain, "domain");
  if (domainHit) return domainHit;

  if (input.lead.name) {
    const nameHit = await pick(await leadIdsByExactName(db, input.lead.name), "name");
    if (nameHit) return nameHit;
  }
  return { lead: null, matchedBy: null, ambiguous: [], mergedFrom: null };
}

// ---- Lead create / field updates --------------------------------------------

function defaultStatus(lead: LeadFieldsIn, messages: MessageIn[]): LeadStatus {
  if (lead.status) return lead.status;
  if (messages.some((m) => m.direction === "outbound")) return "reached_out";
  return "new";
}

export async function createLead(ctx: ImportCtx, input: UpsertIn): Promise<Lead> {
  const l = input.lead;
  if (!l.name) {
    throw new BotError(
      400,
      { error: "validation_failed", fields: [{ path: "lead.name", message: "required when no existing lead matches" }] },
      "no match and no lead.name",
    );
  }
  const kind = l.kind ?? "speaking";
  const row = {
    name: l.name,
    type: l.type ?? "other",
    website: l.website ?? null,
    description: l.description ?? null,
    location_country: l.location_country ?? null,
    location_region: l.location_region ?? null,
    status: defaultStatus(l, input.messages),
    source: "bot_import",
    kind,
    inquiry_type: kind === "inquiry" ? (l.inquiry_type ?? "other") : null,
    revisit_on: l.revisit_on ?? null,
    revisit_note: l.revisit_note ?? null,
    ...(l.attribution_override
      ? {
          attribution_override: l.attribution_override,
          attribution_override_reason: l.attribution_override_reason ?? null,
          attribution_override_by: ctx.actor,
          attribution_override_at: new Date().toISOString(),
        }
      : {}),
  };
  ctx.changes.push(`created lead "${l.name}" (status ${row.status})`);
  if (ctx.dry) {
    return { ...row, id: "", suggested_topics: [], source_url: null, fit_rationale: null, name_normalized: "", created_at: "", updated_at: "" } as unknown as Lead;
  }
  const { data, error } = await ctx.db.from("leads").insert(row).select("*").single();
  if (error || !data) throw new Error(`leads insert: ${error?.message ?? "no row"}`);
  const lead = data as Lead;
  await interaction(
    ctx,
    lead.id,
    "note",
    `Lead created by bot from ${ctx.sourceInbox}${l.status_reason ? `: ${l.status_reason}` : "."}`,
  );
  return lead;
}

/**
 * Apply the lead fields the bot sent to an existing lead. Absent fields are
 * left alone; explicit null clears only revisit_on / revisit_note /
 * attribution_override (other nulls are ignored). Status goes through
 * applyStatus (blocked guard, follow-up stop).
 */
export async function updateLeadFields(ctx: ImportCtx, lead: Lead, l: LeadFieldsIn): Promise<Lead> {
  const patch: Record<string, unknown> = {};
  const simple = ["name", "website", "type", "description", "location_country", "location_region"] as const;
  for (const k of simple) {
    const v = l[k];
    if (v === undefined || v === null) continue;
    if ((lead[k] ?? null) !== v) {
      patch[k] = v;
      ctx.changes.push(`${k}: ${JSON.stringify(lead[k] ?? null)} -> ${JSON.stringify(v)}`);
    }
  }
  if (Object.keys(patch).length > 0 && !ctx.dry) {
    const { error } = await ctx.db.from("leads").update(patch).eq("id", lead.id);
    if (error) throw new Error(`leads update: ${error.message}`);
  }
  let next = { ...lead, ...patch } as Lead;

  // Kind (speaking / inquiry). Becoming an inquiry takes the lead out of all
  // automation, the same way the Advanced panel does (stop + unqueue).
  if (l.kind !== undefined || l.inquiry_type !== undefined) {
    const kind = l.kind ?? next.kind ?? "speaking";
    const type = kind === "inquiry" ? (l.inquiry_type ?? next.inquiry_type ?? "other") : null;
    if (kind !== (next.kind ?? "speaking") || (type ?? null) !== (next.inquiry_type ?? null)) {
      ctx.changes.push(`kind: ${next.kind ?? "speaking"}${next.inquiry_type ? `/${next.inquiry_type}` : ""} -> ${kind}${type ? `/${type}` : ""}`);
      if (!ctx.dry) {
        const { error } = await ctx.db.from("leads").update({ kind, inquiry_type: type }).eq("id", lead.id);
        if (error) throw new Error(`leads kind update: ${error.message}`);
        if (kind === "inquiry") {
          await stopSequencesForLead(ctx.db, lead.id, "bot: reclassified as a non-booking inquiry");
          await ctx.db.from("outreach").update({ status: "draft", scheduled_for: null }).eq("lead_id", lead.id).eq("status", "queued");
        }
      }
      await interaction(ctx, lead.id, "status_change", `Lead kind changed to ${kind}${type ? ` (${type})` : ""} (bot, from ${ctx.sourceInbox}).`);
      next = { ...next, kind, inquiry_type: type };
    }
  }

  // Attribution override: explicit null clears it.
  if (l.attribution_override !== undefined) {
    const cur = next.attribution_override ?? null;
    const reason = l.attribution_override_reason ?? null;
    if (l.attribution_override === null && cur) {
      ctx.changes.push(`attribution_override: ${cur} -> null`);
      if (!ctx.dry) {
        await ctx.db
          .from("leads")
          .update({ attribution_override: null, attribution_override_reason: null, attribution_override_by: null, attribution_override_at: null })
          .eq("id", lead.id);
      }
      await interaction(ctx, lead.id, "note", `Attribution override cleared by ${ctx.actor} (from ${ctx.sourceInbox})${reason ? `: ${reason}` : "."}`);
      next = { ...next, attribution_override: null, attribution_override_reason: null };
    } else if (l.attribution_override && (l.attribution_override !== cur || (reason && reason !== next.attribution_override_reason))) {
      ctx.changes.push(`attribution_override: ${cur ?? "null"} -> ${l.attribution_override}`);
      if (!ctx.dry) {
        await ctx.db
          .from("leads")
          .update({
            attribution_override: l.attribution_override,
            attribution_override_reason: reason,
            attribution_override_by: ctx.actor,
            attribution_override_at: new Date().toISOString(),
          })
          .eq("id", lead.id);
      }
      await interaction(
        ctx,
        lead.id,
        "note",
        `Attribution override set to ${l.attribution_override === "app" ? "App (Tanner)" : "Gmail (Jeff)"} by ${ctx.actor} (from ${ctx.sourceInbox}): ${reason ?? "no reason given"}`,
      );
      next = { ...next, attribution_override: l.attribution_override, attribution_override_reason: reason };
    }
  }

  if (l.status) {
    next = await applyStatus(ctx, next, l.status, l.status_reason ?? "set by bot", { mode: "upsert" });
  }
  if (l.revisit_on !== undefined || l.revisit_note !== undefined) {
    next = await applyRevisit(ctx, next, l.revisit_on, l.revisit_note);
  }
  return next;
}

/**
 * Change status directly in the DB. Blocked is sticky: the status endpoint
 * gets a 409, upsert keeps blocked with a warning. Positive/terminal statuses
 * stop active follow-ups (stop only, never start).
 */
export async function applyStatus(
  ctx: ImportCtx,
  lead: Lead,
  status: LeadStatus,
  reason: string,
  opts: { mode: "upsert" | "endpoint" },
): Promise<Lead> {
  if (lead.status === status) return lead;
  if (lead.status === "blocked") {
    if (opts.mode === "endpoint") {
      throw new BotError(409, { error: "lead_blocked", lead_id: lead.id }, `refused: lead is blocked (asked for ${status})`);
    }
    warn(ctx, "lead is blocked; status unchanged");
    return lead;
  }
  ctx.changes.push(`status ${lead.status} -> ${status}`);
  if (!ctx.dry) {
    const { error } = await ctx.db.from("leads").update({ status }).eq("id", lead.id);
    if (error) throw new Error(`status update: ${error.message}`);
  }
  await interaction(
    ctx,
    lead.id,
    "status_change",
    `${statusLabel(lead.status)} -> ${statusLabel(status)} (bot, from ${ctx.sourceInbox}): ${reason}`,
  );
  if (STOP_FOLLOWUP_STATUSES.includes(status)) {
    if (ctx.dry) {
      const { count } = await ctx.db
        .from("followup_sequences")
        .select("id", { count: "exact", head: true })
        .eq("lead_id", lead.id)
        .in("status", ["active", "paused"]);
      if (count) ctx.changes.push(`would stop ${count} follow-up sequence(s)`);
    } else {
      const { data } = await ctx.db
        .from("followup_sequences")
        .update({ status: "stopped", stop_reason: `bot status change: ${status}`, next_due_at: null })
        .eq("lead_id", lead.id)
        .in("status", ["active", "paused"])
        .select("id");
      if (data?.length) ctx.changes.push(`stopped ${data.length} follow-up sequence(s)`);
    }
  }
  return { ...lead, status };
}

/** revisit_on / revisit_note: undefined = leave; null = clear. */
export async function applyRevisit(
  ctx: ImportCtx,
  lead: Lead,
  on: string | null | undefined,
  note: string | null | undefined,
): Promise<Lead> {
  const patch: Record<string, string | null> = {};
  if (on !== undefined && on !== (lead.revisit_on ?? null)) patch.revisit_on = on;
  if (note !== undefined && (note || null) !== (lead.revisit_note ?? null)) patch.revisit_note = note || null;
  if (Object.keys(patch).length === 0) return lead;
  const newOn = "revisit_on" in patch ? patch.revisit_on : (lead.revisit_on ?? null);
  const newNote = "revisit_note" in patch ? patch.revisit_note : (lead.revisit_note ?? null);
  ctx.changes.push(`revisit ${lead.revisit_on ?? "none"} -> ${newOn ?? "none"}`);
  if (!ctx.dry) {
    const { error } = await ctx.db.from("leads").update(patch).eq("id", lead.id);
    if (error) throw new Error(`revisit update: ${error.message}`);
  }
  await interaction(
    ctx,
    lead.id,
    "note",
    newOn
      ? `Revisit date set to ${newOn}${newNote ? `: ${newNote}` : "."} (bot, from ${ctx.sourceInbox})`
      : `Revisit date cleared (bot, from ${ctx.sourceInbox}).`,
  );
  return { ...lead, revisit_on: newOn, revisit_note: newNote };
}

// ---- Contacts ----------------------------------------------------------------

interface ContactState {
  id: string;
  email: string;
  name: string | null;
  contact_status: string;
}

export interface ContactBook {
  leadId: string;
  byEmail: Map<string, ContactState>;
  added: number;
  updated: number;
  /** Addresses known to belong to another lead (checked once each). */
  foreign: Map<string, string | null>;
}

export async function loadContacts(ctx: ImportCtx, leadId: string): Promise<ContactBook> {
  const book: ContactBook = { leadId, byEmail: new Map(), added: 0, updated: 0, foreign: new Map() };
  if (!leadId) return book;
  const { data, error } = await ctx.db.from("contacts").select("id, email, name, contact_status").eq("lead_id", leadId);
  if (error) throw new Error(`contacts read: ${error.message}`);
  for (const c of (data ?? []) as Array<{ id: string; email: string | null; name: string | null; contact_status: string }>) {
    const e = c.email?.trim().toLowerCase();
    if (e && !book.byEmail.has(e)) book.byEmail.set(e, { id: c.id, email: e, name: c.name, contact_status: c.contact_status });
  }
  return book;
}

/** The lead id that already owns this address elsewhere, or null. */
async function otherLeadFor(ctx: ImportCtx, book: ContactBook, email: string): Promise<string | null> {
  if (book.foreign.has(email)) return book.foreign.get(email) ?? null;
  let q = ctx.db.from("contacts").select("lead_id").ilike("email", escapeLike(email)).limit(1);
  if (book.leadId) q = q.neq("lead_id", book.leadId);
  const { data } = await q;
  const other = ((data ?? []) as Array<{ lead_id: string }>)[0]?.lead_id ?? null;
  book.foreign.set(email, other);
  return other;
}

/**
 * Find or create the contact for an address on this lead. Flake-side
 * addresses are skipped; an address that already belongs to another lead is
 * never copied here (warning instead). `verified` = the address has actually
 * sent mail; an existing unverified/needs_lookup contact is upgraded then.
 */
export async function ensureContact(
  ctx: ImportCtx,
  book: ContactBook,
  email: string,
  opts: { verified: boolean; name?: string | null; fields?: ContactIn; explicit?: boolean },
): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (isOwnAddress(e)) {
    if (opts.explicit) warn(ctx, `${e} is a Flake-side address; not added as a contact`);
    return null;
  }
  if (!opts.explicit && !looksLikeRealEmail(e)) return null;
  const existing = book.byEmail.get(e);
  const f = opts.fields;
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (opts.verified && (existing.contact_status === "unverified" || existing.contact_status === "needs_lookup")) {
      patch.contact_status = "verified";
    }
    if (!existing.name && (f?.name || opts.name)) patch.name = f?.name || opts.name;
    if (f) {
      for (const k of ["name", "role", "phone", "ooo_until", "ooo_reason"] as const) {
        if (f[k] !== undefined && f[k] !== null) patch[k] = f[k];
      }
      if (f.referred_by_email) {
        const ref = book.byEmail.get(f.referred_by_email);
        if (ref && ref.id !== existing.id) patch.referred_by_contact_id = ref.id;
        else if (!ref) warn(ctx, `referred_by_email ${f.referred_by_email} is not a contact on this lead`);
      }
    }
    if (Object.keys(patch).length > 0 && !existing.id.startsWith("dry:")) {
      // Only count a real change: compare with the stored row.
      const { data: cur } = await ctx.db.from("contacts").select("*").eq("id", existing.id).maybeSingle();
      const row = (cur ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(patch)) if ((row[k] ?? null) === patch[k]) delete patch[k];
      if (Object.keys(patch).length > 0) {
        if (!ctx.dry) {
          const { error } = await ctx.db.from("contacts").update(patch).eq("id", existing.id);
          if (error) throw new Error(`contacts update: ${error.message}`);
        }
        book.updated += 1;
        if (typeof patch.name === "string") existing.name = patch.name;
        if (typeof patch.contact_status === "string") existing.contact_status = patch.contact_status;
      }
    }
    return existing.id;
  }

  const other = await otherLeadFor(ctx, book, e);
  if (other) {
    warn(ctx, `${e} already belongs to lead ${other}; not added to this lead`);
    return null;
  }
  let referredBy: string | null = null;
  if (f?.referred_by_email) {
    const ref = book.byEmail.get(f.referred_by_email);
    if (ref && !ref.id.startsWith("dry:")) referredBy = ref.id;
    else if (!ref) warn(ctx, `referred_by_email ${f.referred_by_email} is not a contact on this lead`);
  }
  const row = {
    lead_id: book.leadId,
    email: e,
    name: f?.name ?? opts.name ?? null,
    role: f?.role ?? null,
    phone: f?.phone ?? null,
    ooo_until: f?.ooo_until ?? null,
    ooo_reason: f?.ooo_reason ?? null,
    referred_by_contact_id: referredBy,
    contact_status: opts.verified ? "verified" : "unverified",
  };
  book.added += 1;
  if (ctx.dry || !book.leadId) {
    const id = `dry:${e}`;
    book.byEmail.set(e, { id, email: e, name: row.name, contact_status: row.contact_status });
    return id;
  }
  const { data, error } = await ctx.db.from("contacts").insert(row).select("id").single();
  if (error || !data) throw new Error(`contacts insert: ${error?.message ?? "no row"}`);
  const id = (data as { id: string }).id;
  book.byEmail.set(e, { id, email: e, name: row.name, contact_status: row.contact_status });
  return id;
}

/** Upsert the explicit contacts[] list. */
export async function upsertContacts(
  ctx: ImportCtx,
  book: ContactBook,
  contacts: ContactIn[],
  senders: Set<string>,
): Promise<void> {
  // Referrers first so referred_by_email can resolve within one call.
  const ordered = [...contacts].sort((a, b) => Number(Boolean(a.referred_by_email)) - Number(Boolean(b.referred_by_email)));
  for (const c of ordered) {
    await ensureContact(ctx, book, c.email, { verified: senders.has(c.email), fields: c, explicit: true });
  }
}

// ---- Messages ----------------------------------------------------------------

export interface MessageResult {
  logged: number;
  duplicates: number;
}

const realId = (id: string | null) => (id && !id.startsWith("dry:") ? id : null);

/**
 * Log correspondence on a lead (see file header for the rules). Messages are
 * processed oldest first.
 */
export async function logMessages(
  ctx: ImportCtx,
  lead: Lead,
  book: ContactBook,
  messages: MessageIn[],
  opts: { revisitExplicit: boolean },
): Promise<MessageResult> {
  const res: MessageResult = { logged: 0, duplicates: 0 };
  if (messages.length === 0) return res;
  const db = ctx.db;
  const sorted = [...messages].sort((a, b) => a.sent_at.localeCompare(b.sent_at));

  // Dedupe prefetch (global, not per lead: the same email is one row).
  const gids = Array.from(new Set(sorted.map((m) => m.gmail_message_id).filter((x): x is string => Boolean(x))));
  const rfcs = Array.from(new Set(sorted.map((m) => m.rfc822_message_id).filter((x): x is string => Boolean(x))));
  const seenInboxGid = new Set<string>();
  const seenRfc = new Set<string>();
  const outreachGid = new Set<string>();
  for (let i = 0; i < gids.length; i += 100) {
    const chunk = gids.slice(i, i + 100);
    const [lm, out] = await Promise.all([
      db.from("lead_messages").select("source_inbox, gmail_message_id").in("gmail_message_id", chunk),
      db.from("outreach").select("gmail_message_id").in("gmail_message_id", chunk),
    ]);
    if (lm.error) throw new Error(`lead_messages read: ${lm.error.message}`);
    for (const r of (lm.data ?? []) as Array<{ source_inbox: string | null; gmail_message_id: string }>) {
      seenInboxGid.add(`${r.source_inbox ?? ""}|${r.gmail_message_id}`);
    }
    for (const r of (out.data ?? []) as Array<{ gmail_message_id: string }>) outreachGid.add(r.gmail_message_id);
  }
  for (let i = 0; i < rfcs.length; i += 100) {
    const { data, error } = await db.from("lead_messages").select("rfc822_message_id").in("rfc822_message_id", rfcs.slice(i, i + 100));
    if (error) throw new Error(`lead_messages read: ${error.message}`);
    for (const r of (data ?? []) as Array<{ rfc822_message_id: string }>) seenRfc.add(r.rfc822_message_id);
  }

  // Sent outreach on this lead, for replied_at.
  type OutRow = { id: string; contact_id: string | null; gmail_thread_id: string | null; sent_at: string | null; replied_at: string | null };
  let sentOutreach: OutRow[] = [];
  if (lead.id) {
    const { data } = await db
      .from("outreach")
      .select("id, contact_id, gmail_thread_id, sent_at, replied_at")
      .eq("lead_id", lead.id)
      .eq("status", "sent");
    sentOutreach = (data ?? []) as OutRow[];
  }

  let newestHuman: MessageIn | null = null;

  for (const m of sorted) {
    const isDup =
      (m.gmail_message_id && seenInboxGid.has(`${m.source_inbox}|${m.gmail_message_id}`)) ||
      (m.rfc822_message_id && seenRfc.has(m.rfc822_message_id)) ||
      (m.direction === "outbound" && m.gmail_message_id && outreachGid.has(m.gmail_message_id));
    if (isDup) {
      res.duplicates += 1;
      continue;
    }
    // Mark as seen for the rest of this payload.
    if (m.gmail_message_id) seenInboxGid.add(`${m.source_inbox}|${m.gmail_message_id}`);
    if (m.rfc822_message_id) seenRfc.add(m.rfc822_message_id);

    // Counterparty contacts.
    let contactId: string | null = null;
    if (m.direction === "inbound") {
      contactId = await ensureContact(ctx, book, m.from_email, { verified: true, name: m.from_name });
    } else {
      for (const r of [...m.to, ...m.cc]) {
        const id = await ensureContact(ctx, book, r, { verified: false });
        contactId ??= id;
      }
    }

    const subject = m.subject ?? "(no subject)";
    if (ctx.dry) {
      res.logged += 1;
      if (m.direction === "outbound" && m.gmail_message_id) outreachGid.add(m.gmail_message_id);
    } else {
      const { data: inserted, error } = await db
        .from("lead_messages")
        .insert({
          lead_id: lead.id,
          contact_id: realId(contactId),
          direction: m.direction,
          from_email: m.from_email,
          from_name: m.from_name,
          to_emails: m.to,
          cc_emails: m.cc,
          sent_at: m.sent_at,
          subject: m.subject,
          body: m.body,
          snippet: m.snippet,
          source_inbox: m.source_inbox,
          gmail_message_id: m.gmail_message_id,
          gmail_thread_id: m.gmail_thread_id,
          rfc822_message_id: m.rfc822_message_id,
          created_by: ctx.actor,
        })
        .select("id")
        .single();
      if (error) {
        if (isUniqueViolation(error)) {
          res.duplicates += 1;
          continue;
        }
        throw new Error(`lead_messages insert: ${error.message}`);
      }
      res.logged += 1;
      const messageId = (inserted as { id: string }).id;

      if (m.direction === "outbound") {
        // A 'sent' (never 'queued') outreach row so the guard and attribution
        // see it. No follow-up sequence is created for it.
        const { data: out, error: outErr } = await db
          .from("outreach")
          .insert({
            lead_id: lead.id,
            contact_id: realId(contactId),
            subject,
            body: m.body ?? m.snippet ?? "",
            status: "sent",
            sent_via: m.sent_via,
            sent_at: m.sent_at,
            gmail_message_id: m.gmail_message_id,
            gmail_thread_id: m.gmail_thread_id,
          })
          .select("id")
          .single();
        if (outErr) throw new Error(`outreach insert: ${outErr.message}`);
        const outreachId = (out as { id: string }).id;
        if (m.gmail_message_id) outreachGid.add(m.gmail_message_id);
        await db.from("lead_messages").update({ outreach_id: outreachId }).eq("id", messageId);
        sentOutreach.push({ id: outreachId, contact_id: realId(contactId), gmail_thread_id: m.gmail_thread_id, sent_at: m.sent_at, replied_at: null });
      }
    }

    if (m.direction === "outbound") {
      await interaction(ctx, lead.id, "email_sent", `Email sent (logged by bot from ${m.source_inbox}): ${subject}`, m.source_inbox);
    } else {
      await interaction(
        ctx,
        lead.id,
        "note",
        `Reply received (logged by bot from ${m.source_inbox}) from ${m.from_email}: ${subject}`,
        m.source_inbox,
      );
      // replied_at on the outreach this answers (same thread, or to this person).
      for (const o of sentOutreach) {
        if (o.replied_at || !o.sent_at || o.sent_at >= m.sent_at) continue;
        const sameThread = m.gmail_thread_id && o.gmail_thread_id === m.gmail_thread_id;
        const samePerson = contactId && o.contact_id === contactId;
        if (!sameThread && !samePerson) continue;
        o.replied_at = m.sent_at;
        if (!ctx.dry) await db.from("outreach").update({ replied_at: m.sent_at }).eq("id", o.id).is("replied_at", null);
      }
      if (!isAutomatedMessage(m.from_email, m.subject ?? "")) newestHuman = m;
    }
  }

  if (newestHuman && lead.id) await afterHumanReply(ctx, lead, newestHuman, opts);
  if (res.logged > 0) ctx.changes.push(`${res.logged} message(s) logged`);
  return res;
}

/**
 * A real person at the org wrote back:
 * - Revisit: if the lead has a FUTURE revisit date and the reply is dated
 *   after the last status/revisit change, clear it the same way the reply
 *   scanner does (owner's rule: if they reach out before the revisit date,
 *   wipe the revisit note). Skipped when this call set revisit explicitly.
 * - Follow-ups: a reply newer than an active sequence stops follow-ups to
 *   everyone at the organization (as the reply scanner does).
 * Status is NOT changed.
 */
async function afterHumanReply(
  ctx: ImportCtx,
  lead: Lead,
  m: MessageIn,
  opts: { revisitExplicit: boolean },
): Promise<void> {
  const db = ctx.db;
  const who = m.from_name || m.from_email;
  const today = localDatePlus(0);
  if (!opts.revisitExplicit && lead.revisit_on && lead.revisit_on > today) {
    const { data } = await db
      .from("interactions")
      .select("created_at, kind, detail")
      .eq("lead_id", lead.id)
      .or("kind.eq.status_change,detail.ilike.Revisit%")
      .order("created_at", { ascending: false })
      .limit(1);
    const lastChange = ((data ?? []) as Array<{ created_at: string }>)[0]?.created_at ?? null;
    if (!lastChange || m.sent_at > lastChange) {
      ctx.changes.push(`revisit ${lead.revisit_on} cleared (reply from ${m.from_email} before the revisit date)`);
      if (!ctx.dry) {
        await applyRevisitForReply(
          db,
          lead.id,
          { fromName: who, revisitOn: null, revisitReason: null },
          { actor: ctx.actor, source_inbox: m.source_inbox },
        );
      }
    }
  }

  const { data: seqs } = await db
    .from("followup_sequences")
    .select("id, created_at")
    .eq("lead_id", lead.id)
    .in("status", ["active", "paused"]);
  const older = ((seqs ?? []) as Array<{ created_at: string }>).some((s) => s.created_at < m.sent_at);
  if (older) {
    ctx.changes.push("follow-ups stopped (human reply)");
    if (!ctx.dry) {
      await stopFollowupsForOrganization(db, lead.id, `Reply from ${who} (logged by bot from ${m.source_inbox}).`);
    }
  }
}

// ---- Engagements -------------------------------------------------------------

export interface EngagementResult {
  added: number;
  updated: number;
  ids: string[];
}

const ENG_FIELDS = ["event_name", "event_date", "event_end_date", "event_year", "fee", "topic", "location", "outcome", "is_recurring", "notes"] as const;

/**
 * Upsert engagements (bookings). Match: id -> same lead + same event_date ->
 * same lead + same event_year + same event name (case-insensitive). New rows
 * get source 'bot_import' and source_inbox; the DB trigger fills
 * event_year/outcome when omitted. Does not change lead status.
 */
export async function upsertEngagements(ctx: ImportCtx, leadId: string, list: EngagementIn[]): Promise<EngagementResult> {
  const res: EngagementResult = { added: 0, updated: 0, ids: [] };
  if (list.length === 0) return res;
  let existing: Booking[] = [];
  if (leadId) {
    const { data, error } = await ctx.db.from("bookings").select("*").eq("lead_id", leadId);
    if (error) throw new Error(`bookings read: ${error.message}`);
    existing = (data ?? []) as Booking[];
  }
  for (const e of list) {
    let match: Booking | undefined;
    if (e.id) {
      match = existing.find((b) => b.id === e.id);
      if (!match) {
        warn(ctx, `engagement ${e.id} is not on this lead; skipped`);
        continue;
      }
    }
    if (!match && e.event_date) match = existing.find((b) => b.event_date === e.event_date);
    const year = e.event_year ?? (e.event_date ? Number(e.event_date.slice(0, 4)) : null);
    if (!match && year != null && e.event_name) {
      const n = e.event_name.trim().toLowerCase();
      match = existing.find((b) => b.event_year === year && b.event_name.trim().toLowerCase() === n);
    }

    if (match) {
      const patch: Record<string, unknown> = {};
      for (const k of ENG_FIELDS) {
        const v = e[k];
        if (v === undefined) continue;
        if (k === "event_name" && !v) continue;
        const cur = (match as unknown as Record<string, unknown>)[k] ?? null;
        const same = k === "fee" ? (cur == null ? v == null : Number(cur) === v) : cur === v;
        if (!same) patch[k] = v;
      }
      if (Object.keys(patch).length === 0) {
        res.ids.push(match.id);
        continue;
      }
      if (!ctx.dry) {
        const { error } = await ctx.db.from("bookings").update(patch).eq("id", match.id);
        if (error) throw new Error(`bookings update: ${error.message}`);
      }
      Object.assign(match, patch);
      res.updated += 1;
      res.ids.push(match.id);
      await interaction(
        ctx,
        leadId,
        "note",
        `Engagement updated (bot, from ${ctx.sourceInbox}): ${match.event_name}${match.event_year ? ` (${match.event_year})` : ""}; ${Object.keys(patch).join(", ")}.`,
      );
      continue;
    }

    const row = {
      lead_id: leadId,
      event_name: e.event_name as string,
      event_date: e.event_date ?? null,
      event_end_date: e.event_end_date ?? null,
      event_year: year,
      fee: e.fee ?? null,
      topic: e.topic ?? null,
      location: e.location ?? null,
      outcome: e.outcome ?? null,
      is_recurring: e.is_recurring ?? false,
      notes: e.notes ?? null,
      source: "bot_import",
      source_inbox: ctx.sourceInbox,
    };
    res.added += 1;
    if (ctx.dry || !leadId) {
      existing.push({ ...row, id: `dry:${res.added}`, created_at: "" } as Booking);
      continue;
    }
    const { data, error } = await ctx.db.from("bookings").insert(row).select("*").single();
    if (error || !data) throw new Error(`bookings insert: ${error?.message ?? "no row"}`);
    const b = data as Booking;
    existing.push(b);
    res.ids.push(b.id);
    await interaction(
      ctx,
      leadId,
      "note",
      `Engagement added (bot, from ${ctx.sourceInbox}): ${b.event_name} (${b.event_date ?? b.event_year ?? "date TBD"}${b.outcome ? `, ${b.outcome}` : ""}).`,
    );
  }
  if (res.added) ctx.changes.push(`${res.added} engagement(s) added`);
  if (res.updated) ctx.changes.push(`${res.updated} engagement(s) updated`);
  return res;
}

// ---- Free-text note ------------------------------------------------------------

/** Add the call's note unless the exact same note is already on the lead. */
export async function addNoteOnce(ctx: ImportCtx, leadId: string, note: string): Promise<void> {
  const detail = `Bot note (from ${ctx.sourceInbox}): ${note}`;
  if (leadId) {
    const { data } = await ctx.db.from("interactions").select("id").eq("lead_id", leadId).eq("detail", detail).limit(1);
    if ((data ?? []).length > 0) return;
  }
  ctx.changes.push("note added");
  await interaction(ctx, leadId, "note", detail);
}

// ---- Upsert (one call does it all) --------------------------------------------

export async function runUpsert(ctx: ImportCtx, input: UpsertIn) {
  const resolution = await resolveForUpsert(ctx.db, input);
  let lead: Lead;
  let created = false;
  if (resolution.lead) {
    lead = resolution.lead;
    if (resolution.mergedFrom) ctx.changes.push(`redirected from merged lead ${resolution.mergedFrom}`);
    lead = await updateLeadFields(ctx, lead, input.lead);
  } else {
    lead = await createLead(ctx, input);
    created = true;
  }
  if (resolution.ambiguous.length > 0) {
    warn(ctx, `${resolution.ambiguous.length + 1} leads matched; used the most recently active non-junk one`);
  }

  // Addresses that have actually sent mail in this payload.
  const senders = new Set(input.messages.filter((m) => m.direction === "inbound").map((m) => m.from_email));
  const book = await loadContacts(ctx, lead.id);
  await upsertContacts(ctx, book, input.contacts, senders);
  const messages = await logMessages(ctx, lead, book, input.messages, {
    revisitExplicit: input.lead.revisit_on !== undefined || input.lead.revisit_note !== undefined,
  });
  const engagements = await upsertEngagements(ctx, lead.id, input.engagements);
  if (input.note) await addNoteOnce(ctx, lead.id, input.note);
  if (book.added) ctx.changes.push(`${book.added} contact(s) added`);
  if (book.updated) ctx.changes.push(`${book.updated} contact(s) updated`);

  // One summary line per call, only when something changed (re-sends stay silent).
  const meaningful = ctx.changes.filter((c) => !c.startsWith("redirected"));
  if (meaningful.length > 0 && lead.id) {
    await interaction(ctx, lead.id, "note", `Bot import from ${ctx.sourceInbox}: ${meaningful.join("; ")}.`);
  }

  return {
    ok: true,
    dry_run: ctx.dry,
    lead_id: lead.id || null,
    created,
    matched_by: resolution.matchedBy,
    ...(resolution.mergedFrom ? { merged_from: resolution.mergedFrom } : {}),
    ...(resolution.ambiguous.length ? { ambiguous_candidates: resolution.ambiguous } : {}),
    status: lead.status,
    changes: ctx.changes,
    messages,
    contacts: { added: book.added, updated: book.updated },
    engagements: { added: engagements.added, updated: engagements.updated },
    warnings: ctx.warnings,
  };
}

/** "upsert: created lead X; 2 contacts added; ..." for bot_activity. */
export function activitySummary(prefix: string, ctx: ImportCtx, extra: string[] = []): string {
  const parts = [...ctx.changes, ...extra];
  const body = parts.length ? parts.join("; ") : "no changes";
  const warns = ctx.warnings.length ? ` | warnings: ${ctx.warnings.join("; ")}` : "";
  return `${ctx.dry ? "DRY RUN " : ""}${prefix}: ${body}${warns}`;
}
