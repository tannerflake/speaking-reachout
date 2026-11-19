import type { SupabaseClient } from "@supabase/supabase-js";
import { orgDomainOfEmail } from "@/lib/utils";
import { isSharedEventDomain } from "@/lib/outreach/sharedDomains";
import {
  allocateSlot,
  timeZoneForLocation,
  type Reservation,
} from "@/lib/outreach/schedule";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * The database side of the send schedule (rules in lib/outreach/schedule.ts):
 * what has gone out recently and what is already planned, so a new slot can
 * be fitted around both.
 */

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

/**
 * Who counts as "the same organization" for spacing: the lead, plus the
 * recipient's email domain (two leads for one school share it). Shared event
 * company domains (Informa, Emerald, ...) are left out; they say nothing
 * about which event someone works on.
 */
export function orgKeysFor(leadId: string, email: string | null | undefined): string[] {
  const keys = [`lead:${leadId}`];
  const domain = orgDomainOfEmail(email);
  if (domain && !isSharedEventDomain(domain)) keys.push(`dom:${domain}`);
  return keys;
}

type LocationJoin = { location_region: string | null; location_country: string | null };

export function tzOfLead(lead: LocationJoin | LocationJoin[] | null | undefined): string {
  const l = one(lead);
  return timeZoneForLocation(l?.location_region ?? null, l?.location_country ?? null);
}

export interface PlannedSend extends Reservation {
  kind: "outreach" | "followup";
  id: string;
}

export interface SendLedger {
  /** Emails that actually went out in the last few days. */
  sent: Reservation[];
  /** Queued first emails and scheduled follow-ups, from a few minutes ago on. */
  planned: PlannedSend[];
}

const SENT_LOOKBACK_MS = 3 * 24 * 3600 * 1000;

export async function loadSendLedger(db: Db): Promise<SendLedger> {
  const now = Date.now();
  const sinceSent = new Date(now - SENT_LOOKBACK_MS).toISOString();
  const sincePlanned = new Date(now - 15 * 60_000).toISOString();
  type Row = {
    id: string;
    lead_id: string;
    at: string | null;
    contact: { email: string | null } | { email: string | null }[] | null;
  };
  const [sentRes, queuedRes, seqRes] = await Promise.all([
    db
      .from("outreach")
      .select("id, lead_id, at:sent_at, contact:contacts(email)")
      .eq("status", "sent")
      .gte("sent_at", sinceSent)
      .limit(5000),
    db
      .from("outreach")
      .select("id, lead_id, at:scheduled_for, contact:contacts(email)")
      .eq("status", "queued")
      .gte("scheduled_for", sincePlanned)
      .limit(5000),
    db
      .from("followup_sequences")
      .select("id, lead_id, at:next_due_at, contact:contacts(email)")
      .eq("status", "active")
      .gte("next_due_at", sincePlanned)
      .limit(5000),
  ]);
  for (const r of [sentRes, queuedRes, seqRes]) {
    if (r.error) throw new Error(`Could not load the send schedule: ${r.error.message}`);
  }
  const toRes = (r: Row): Reservation | null =>
    r.at ? { at: new Date(r.at).getTime(), orgKeys: orgKeysFor(r.lead_id, one(r.contact)?.email) } : null;

  const sent = ((sentRes.data ?? []) as unknown as Row[])
    .map(toRes)
    .filter((r): r is Reservation => r !== null);
  const planned: PlannedSend[] = [];
  for (const [kind, res] of [
    ["outreach", queuedRes],
    ["followup", seqRes],
  ] as const) {
    for (const r of (res.data ?? []) as unknown as Row[]) {
      const base = toRes(r);
      if (base) planned.push({ ...base, kind, id: r.id });
    }
  }
  return { sent, planned };
}

/** Everything a new slot must keep its distance from. */
export function reservationsOf(
  ledger: SendLedger,
  exclude?: { kind: PlannedSend["kind"]; id: string },
): Reservation[] {
  return [
    ...ledger.sent,
    ...ledger.planned.filter((p) => !(exclude && p.kind === exclude.kind && p.id === exclude.id)),
  ];
}

/**
 * Pick a slot and record it in the in-memory ledger so the next allocation in
 * the same batch sees it. The caller writes it to the row.
 */
export function takeSlot(
  ledger: SendLedger,
  item: { kind: PlannedSend["kind"]; id: string; leadId: string; email: string | null; tz: string },
  earliest: number,
): number {
  const orgKeys = orgKeysFor(item.leadId, item.email);
  const at = allocateSlot(
    { earliest, tz: item.tz, orgKeys },
    reservationsOf(ledger, { kind: item.kind, id: item.id }),
  );
  ledger.planned = ledger.planned.filter((p) => !(p.kind === item.kind && p.id === item.id));
  ledger.planned.push({ at, orgKeys, kind: item.kind, id: item.id });
  return at;
}

// --- One sender at a time ------------------------------------------------------

const LOCK_NAME = "send-queue";
const LOCK_TTL_MS = 4 * 60_000;

/**
 * Only one queue tick may send at a time (the minute cron, the Leads page
 * poll and a second tab can all fire together; two sends in the same second
 * would break the pacing). Uses the app_locks row from migration 0031. Before
 * that migration there is no lock and the per-row claim is the only guard.
 * Returns a release function, or null when another tick holds the lock.
 */
export async function acquireSendLock(
  db: Db,
  retry = true,
): Promise<(() => Promise<void>) | null> {
  const holder = crypto.randomUUID();
  const now = new Date();
  const { data, error } = await db
    .from("app_locks")
    .update({ locked_until: new Date(now.getTime() + LOCK_TTL_MS).toISOString(), holder })
    .eq("name", LOCK_NAME)
    .lt("locked_until", now.toISOString())
    .select("name");
  if (error) return async () => undefined; // table missing: run unlocked
  if (!data || data.length === 0) {
    const { count } = await db
      .from("app_locks")
      .select("name", { count: "exact", head: true })
      .eq("name", LOCK_NAME);
    if (count === 0 && retry) {
      await db.from("app_locks").insert({ name: LOCK_NAME, locked_until: now.toISOString() });
      return acquireSendLock(db, false);
    }
    return null;
  }
  return async () => {
    await db
      .from("app_locks")
      .update({ locked_until: new Date(Date.now() - 1000).toISOString() })
      .eq("name", LOCK_NAME)
      .eq("holder", holder);
  };
}
