import type { SupabaseClient } from "@supabase/supabase-js";
import { localDatePlus } from "@/lib/attribution";
import { loadSendLedger, takeSlot, tzOfLead } from "@/lib/outreach/slots";
import {
  HOLIDAY_NOTE_PREFIX,
  holidayNote,
  holidayReason,
  resumeEarliestMs,
} from "@/lib/followups/holiday";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

// Leads where a revisit date no longer means anything.
const NO_REVISIT_STATUSES = ["booked", "closed", "closed_not_me", "junk"];

export interface HolidayApplyResult {
  /** The contact was found and marked out (or already was, from this message). */
  applied: boolean;
  /** Same OOO already processed (rescan); nothing changed. */
  duplicate?: boolean;
  leadId?: string;
  note?: string;
  /** Follow-up sequences and queued first emails moved to the resume date. */
  moved?: number;
}

type ContactRow = {
  id: string;
  lead_id: string;
  name: string | null;
  email: string | null;
  ooo_until?: string | null;
  ooo_reason?: string | null;
};

/**
 * Apply a holiday out-of-office to the contact who sent it:
 *   - contacts.ooo_until / ooo_reason (migration 0035; skipped if absent)
 *   - the lead's revisit date, unless a later or human-set future date exists
 *   - an activity note
 *   - the contact's active follow-up sequence and any queued email moved to
 *     the start of the send window on the resume date (pacing/caps re-fitted)
 * Lead status is never touched. Other contacts at the org are untouched.
 * Idempotent: a repeat of the same OOO (same note text) changes nothing.
 */
export async function applyHolidayOoo(
  db: Db,
  p: {
    leadIds: string[];
    /** The outreach the OOO answered, when matched by thread or contact. */
    outreachId: string | null;
    senderEmail: string;
    fromName: string;
    returnDate: string | null;
    resume: string;
  },
): Promise<HolidayApplyResult> {
  // 1. Which contact is out: the sender's own contact row on a matched lead,
  // else the recipient of the outreach the OOO came back on.
  let contact: ContactRow | null = null;
  if (p.leadIds.length) {
    const { data } = await db
      .from("contacts")
      .select("*")
      .in("lead_id", p.leadIds);
    const sender = p.senderEmail.trim().toLowerCase();
    contact =
      ((data as ContactRow[] | null) ?? []).find(
        (c) => (c.email ?? "").trim().toLowerCase() === sender,
      ) ?? null;
  }
  if (!contact && p.outreachId) {
    const { data } = await db
      .from("outreach")
      .select("contact:contacts(*)")
      .eq("id", p.outreachId)
      .maybeSingle();
    const c = (data as { contact: ContactRow | ContactRow[] | null } | null)?.contact;
    contact = (Array.isArray(c) ? c[0] : c) ?? null;
  }
  if (!contact) return { applied: false };

  const leadId = contact.lead_id;
  const email = contact.email ?? p.senderEmail;
  const name = contact.name?.trim() || p.fromName;
  // Never shorten a later existing pause.
  const until =
    contact.ooo_until && contact.ooo_until > p.resume ? contact.ooo_until : p.resume;
  const note = holidayNote({ name, email, returnDate: p.returnDate, resume: until });

  // 2. Idempotency: the same OOO already produced this exact note.
  const { data: seen } = await db
    .from("interactions")
    .select("id")
    .eq("lead_id", leadId)
    .eq("detail", note)
    .limit(1);
  if (seen && seen.length) return { applied: true, duplicate: true, leadId, note };

  // 3. Mark the contact out.
  await db
    .from("contacts")
    .update({ ooo_until: until, ooo_reason: holidayReason(p.returnDate, until) })
    .eq("id", contact.id); // errors before migration 0035; the delay below still applies

  // 4. Lead revisit date: set it only when there is none, it has passed, or
  // it is an earlier date WE set for a previous holiday OOO. A future date a
  // person (or a reply) set is left alone, and so is any later date.
  const { data: leadData } = await db.from("leads").select("*").eq("id", leadId).maybeSingle();
  const lead = leadData as {
    status: string;
    revisit_on: string | null;
    revisit_note?: string | null;
    location_region: string | null;
    location_country: string | null;
  } | null;
  if (lead && !NO_REVISIT_STATUSES.includes(lead.status)) {
    const today = localDatePlus(0);
    const on = lead.revisit_on;
    const ours = (lead.revisit_note ?? "").startsWith(HOLIDAY_NOTE_PREFIX);
    if (!on || on <= today || (on < until && ours)) {
      const { error } = await db
        .from("leads")
        .update({ revisit_on: until, revisit_note: note })
        .eq("id", leadId);
      if (error && /revisit_note/.test(error.message)) {
        await db.from("leads").update({ revisit_on: until }).eq("id", leadId);
      }
    }
  }

  // 5. Activity note (also the idempotency marker).
  await db.from("interactions").insert({ lead_id: leadId, kind: "note", detail: note });

  // 6. Delay everything pending for THIS contact to the resume date, at the
  // start of the recipient's send window; the slot allocator still applies
  // the window, pacing, daily caps and org spacing.
  const tz = tzOfLead(lead);
  const earliest = resumeEarliestMs(until, tz);
  const earliestIso = new Date(earliest).toISOString();
  let moved = 0;
  const [seqRes, queuedRes] = await Promise.all([
    db
      .from("followup_sequences")
      .select("id, lead_id, next_due_at")
      .eq("contact_id", contact.id)
      .eq("status", "active"),
    db
      .from("outreach")
      .select("id, lead_id, scheduled_for")
      .eq("contact_id", contact.id)
      .eq("status", "queued"),
  ]);
  const seqs = ((seqRes.data as Array<{ id: string; lead_id: string; next_due_at: string | null }> | null) ?? [])
    .filter((s) => !s.next_due_at || s.next_due_at < earliestIso);
  const queued = ((queuedRes.data as Array<{ id: string; lead_id: string; scheduled_for: string | null }> | null) ?? [])
    .filter((o) => !o.scheduled_for || o.scheduled_for < earliestIso);
  if (seqs.length || queued.length) {
    let ledger: Awaited<ReturnType<typeof loadSendLedger>> | null = null;
    try {
      ledger = await loadSendLedger(db);
    } catch {
      ledger = null; // fall back to the window start; the queue tick re-fits it
    }
    const slot = (kind: "followup" | "outreach", id: string, lid: string) =>
      ledger ? takeSlot(ledger, { kind, id, leadId: lid, email, tz }, earliest) : earliest;
    for (const s of seqs) {
      await db
        .from("followup_sequences")
        .update({ next_due_at: new Date(slot("followup", s.id, s.lead_id)).toISOString() })
        .eq("id", s.id)
        .eq("status", "active");
      moved += 1;
    }
    for (const o of queued) {
      await db
        .from("outreach")
        .update({ scheduled_for: new Date(slot("outreach", o.id, o.lead_id)).toISOString() })
        .eq("id", o.id)
        .eq("status", "queued");
      moved += 1;
    }
  }

  return { applied: true, leadId, note, moved };
}

/**
 * Hard guard helper for the send paths: the next slot on or after the
 * contact's ooo_until date (start of the recipient's send window).
 */
export async function slotAfterHoliday(
  db: Db,
  item: { kind: "followup" | "outreach"; id: string; leadId: string; email: string | null; tz: string },
  oooUntil: string,
): Promise<number> {
  const earliest = resumeEarliestMs(oooUntil, item.tz);
  try {
    const ledger = await loadSendLedger(db);
    return takeSlot(ledger, item, earliest);
  } catch {
    return earliest;
  }
}
