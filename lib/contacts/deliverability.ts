import type { SupabaseClient } from "@supabase/supabase-js";
import { looksLikeRealEmail } from "@/lib/utils";
import { emailVerifierName, verifyEmailAddress, type VerifyResult } from "@/lib/contacts/verify";
import { fetchPage } from "@/lib/contacts/multiSource";
import type { ContactStatus } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * Who may be emailed automatically. Only a "verified" address goes into the
 * send queue: one found on the organization's own pages, confirmed valid by
 * Hunter or the configured verifier, or typed in by the operator. Guessed and
 * pattern-inferred addresses keep their drafts but are held. Bounced and
 * invalid addresses are never sent to again.
 */
export type HoldReason = "no_email" | "needs_verification" | "bounced" | "invalid";

export function sendHoldReason(
  contact: { email: string | null; contact_status: ContactStatus } | null | undefined,
): HoldReason | null {
  if (!contact || !looksLikeRealEmail(contact.email)) return "no_email";
  if (contact.contact_status === "bounced") return "bounced";
  if (contact.contact_status === "invalid") return "invalid";
  if (contact.contact_status !== "verified") return "needs_verification";
  return null;
}

/** How a held draft's error note starts (see holdMessage). */
export const NEEDS_VERIFICATION_PREFIX = "Needs verification:";

export function holdMessage(reason: HoldReason, email?: string | null): string {
  switch (reason) {
    case "no_email":
      return "No valid contact email.";
    case "bounced":
      return `${email ?? "This address"} hard-bounced earlier; it will never be emailed again.`;
    case "invalid":
      return `The email verifier says ${email ?? "this address"} does not exist.`;
    case "needs_verification":
      return `${NEEDS_VERIFICATION_PREFIX} ${email ?? "this address"} was guessed or found without confirmation, and unverified addresses bounce about 1 in 4. Verify it (or set it by hand) before it can be queued.`;
  }
}

type VerifiableContact = {
  id: string;
  lead_id?: string;
  email: string | null;
  contact_status: ContactStatus;
  source_url?: string | null;
  verification_checked_at?: string | null;
  verification_result?: string | null;
};

// An inconclusive result (unknown, or catch-all without a sourced page) is
// not re-checked for this long: re-asking costs credits and rarely changes.
const RECHECK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** A bare homepage ("https://org.edu") is where the Hunter paths record a guess. */
function isNamedPage(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && u.pathname.replace(/\/+$/, "") !== "";
  } catch {
    return false;
  }
}

/**
 * Was this address printed on the specific (non-homepage) page it was
 * sourced from? That is the line between a found address and one guessed
 * from a naming pattern, which is what decides a catch-all result.
 */
export async function printedOnSourcePage(
  email: string,
  sourceUrl: string | null | undefined,
): Promise<boolean> {
  if (!isNamedPage(sourceUrl)) return false;
  const page = await fetchPage(sourceUrl);
  if (!page.fetched) return false;
  const address = email.trim().toLowerCase();
  return page.emails.includes(address) || page.text.includes(address);
}

export interface ContactCheck {
  status: ContactStatus;
  /** What the verifier said (null = not checked this time). */
  outcome: VerifyResult["outcome"] | null;
  /** The verifier itself failed (out of credits, bad key, timeout). */
  providerError?: string;
}

async function saveCheck(
  db: Db,
  id: string,
  next: ContactStatus | null,
  result: string,
): Promise<void> {
  const checked = {
    verification_checked_at: new Date().toISOString(),
    verification_result: result.slice(0, 120),
  };
  const patch = next ? { contact_status: next, ...checked } : checked;
  const { error } = await db.from("contacts").update(patch).eq("id", id);
  if (!error) return;
  // Before migration 0033 there are no verification_* columns; before 0031
  // 'invalid' isn't allowed (park it where nothing sends).
  if (!next) return;
  const { error: e2 } = await db.from("contacts").update({ contact_status: next }).eq("id", id);
  if (e2 && next === "invalid") {
    await db.from("contacts").update({ contact_status: "needs_lookup" }).eq("id", id);
  }
}

/**
 * Verify an unverified contact with the configured verifier and apply the
 * sending policy:
 *   valid                                  -> verified (sendable)
 *   catch-all, printed on its named page   -> verified (sendable)
 *   catch-all from a guess / homepage      -> stays unverified (held)
 *   unknown                                -> stays unverified (held)
 *   invalid / spamtrap / abuse / do_not_mail -> invalid (never sent)
 * With no verifier configured, or on a provider error, nothing changes.
 */
export async function verifyContact(db: Db, contact: VerifiableContact): Promise<ContactCheck> {
  const unchanged: ContactCheck = { status: contact.contact_status, outcome: null };
  if (contact.contact_status !== "unverified" || !looksLikeRealEmail(contact.email)) {
    return unchanged;
  }
  const last = contact.verification_checked_at ? Date.parse(contact.verification_checked_at) : NaN;
  if (Number.isFinite(last) && Date.now() - last < RECHECK_AFTER_MS) return unchanged;

  let result: VerifyResult | null;
  try {
    result = await verifyEmailAddress(contact.email as string);
  } catch (e) {
    return { ...unchanged, providerError: e instanceof Error ? e.message : String(e) };
  }
  if (!result) return unchanged;

  const email = contact.email as string;
  let next: ContactStatus | null =
    result.outcome === "valid" ? "verified" : result.outcome === "invalid" ? "invalid" : null;
  let sourced = false;
  if (result.outcome === "risky") {
    sourced = await printedOnSourcePage(email, contact.source_url);
    if (sourced) next = "verified";
  }
  await saveCheck(db, contact.id, next, `${result.provider}:${result.detail || result.outcome}`);

  if (contact.lead_id) {
    await db.from("interactions").insert({
      lead_id: contact.lead_id,
      kind: "note",
      detail: `Email check (${result.provider}) for ${email}: ${result.detail || result.outcome}${
        next === "verified"
          ? sourced
            ? "; a catch-all domain, but the address is printed on the page it came from, so it is cleared for sending."
            : "; cleared for sending."
          : next === "invalid"
            ? "; the address doesn't exist, so it will not be emailed."
            : result.outcome === "risky"
              ? "; a catch-all domain and the address was not found on a named page (likely a guessed pattern), so it stays held for a human to decide."
              : "; not conclusive, so it stays held for a human to decide."
      }`,
    });
  }
  return { status: next ?? contact.contact_status, outcome: result.outcome };
}

/** verifyContact, returning just the contact's status afterwards. */
export async function verifyContactIfPossible(
  db: Db,
  contact: VerifiableContact,
): Promise<ContactStatus> {
  return (await verifyContact(db, contact)).status;
}

export interface HeldBackfillResult {
  verifier: string | null;
  checked: number;
  verified: number;
  invalid: number;
  stillHeld: number;
  /** Held drafts put back in the send queue (through every queue check). */
  requeued: number;
  error?: string;
}

/**
 * Backfill: verify contacts that are held as "needs verification", oldest
 * first, a small batch per call (the send-queue cron calls this every few
 * minutes while a verifier is configured). Valid ones go back into the
 * normal flow: their drafts lose the hold note, and drafts the operator had
 * already tried to send are queued again via queueOutreach (pacing, guard,
 * plain-email checks all apply). Invalid ones have their drafts failed.
 */
export async function verifyHeldContacts(
  db: Db,
  opts: {
    limit?: number;
    requeue?: (outreachIds: string[]) => Promise<{ queued: number }>;
  } = {},
): Promise<HeldBackfillResult> {
  const verifier = emailVerifierName();
  const out: HeldBackfillResult = {
    verifier,
    checked: 0,
    verified: 0,
    invalid: 0,
    stillHeld: 0,
    requeued: 0,
  };
  if (!verifier) return out;

  // Contacts with a draft waiting on them, not yet checked (or checked over
  // 30 days ago). Needs migration 0033's verification_checked_at: without it
  // the same inconclusive addresses would be re-checked, and paid for, on
  // every call.
  const cutoff = new Date(Date.now() - RECHECK_AFTER_MS).toISOString();
  const { data, error } = await db
    .from("contacts")
    .select("*, outreach!inner(id)")
    .eq("contact_status", "unverified")
    .not("email", "is", null)
    .eq("outreach.status", "draft")
    .or(`verification_checked_at.is.null,verification_checked_at.lt."${cutoff}"`)
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 8);
  if (error) {
    return {
      ...out,
      error: /verification_checked_at/.test(error.message)
        ? "Held-address backfill needs supabase/migrations/0033_discovery_backlog_and_usage.sql."
        : error.message,
    };
  }
  const contacts = (data as VerifiableContact[] | null) ?? [];

  const released: string[] = [];
  const toRequeue: string[] = [];
  for (const c of contacts) {
    const check = await verifyContact(db, c);
    if (check.providerError) {
      // Out of credits / bad key: every later check would fail the same way.
      out.error = `${verifier}: ${check.providerError}`;
      break;
    }
    if (!check.outcome) continue;
    out.checked += 1;
    if (check.status === "verified") {
      out.verified += 1;
      released.push(c.id);
    } else if (check.status === "invalid") {
      out.invalid += 1;
      await db
        .from("outreach")
        .update({ status: "failed", scheduled_for: null, error: holdMessage("invalid", c.email) })
        .eq("contact_id", c.id)
        .in("status", ["draft", "queued"]);
    } else out.stillHeld += 1;
  }

  if (released.length > 0) {
    const { data: held } = await db
      .from("outreach")
      .select("id, error")
      .in("contact_id", released)
      .eq("status", "draft");
    for (const row of (held as Array<{ id: string; error: string | null }> | null) ?? []) {
      if (!row.error?.startsWith(NEEDS_VERIFICATION_PREFIX)) continue;
      toRequeue.push(row.id);
      await db.from("outreach").update({ error: null }).eq("id", row.id);
    }
    if (toRequeue.length > 0 && opts.requeue) {
      out.requeued = (await opts.requeue(toRequeue)).queued;
    }
  }
  return out;
}

/**
 * A hard bounce: mark every contact row with this address as bounced (the same
 * person can sit on several leads), pull its queued email back, and stop its
 * follow-ups. Nothing is ever sent to the address again.
 */
export async function markAddressBounced(
  db: Db,
  email: string,
  detail: string,
): Promise<number> {
  const address = email.trim().toLowerCase();
  if (!looksLikeRealEmail(address)) return 0;
  const { data } = await db
    .from("contacts")
    .select("id, lead_id, contact_status")
    .ilike("email", address);
  const rows = (data as Array<{ id: string; lead_id: string; contact_status: ContactStatus }> | null) ?? [];
  const fresh = rows.filter((r) => r.contact_status !== "bounced");
  if (fresh.length === 0) return 0;
  const ids = fresh.map((r) => r.id);

  const now = new Date().toISOString();
  const { error } = await db
    .from("contacts")
    .update({ contact_status: "bounced", bounced_at: now })
    .in("id", ids);
  if (error) {
    // Before migration 0031: no 'bounced' status or bounced_at column. Park the
    // address where neither the queue nor the verifier will pick it up.
    await db.from("contacts").update({ contact_status: "needs_lookup" }).in("id", ids);
  }

  await db
    .from("outreach")
    .update({ status: "failed", scheduled_for: null, error: `Not sent: ${address} hard-bounced (${detail}).` })
    .in("contact_id", ids)
    .in("status", ["queued", "draft"]);
  await db
    .from("followup_sequences")
    .update({ status: "stopped", stop_reason: "Email bounced.", next_due_at: null })
    .in("contact_id", ids)
    .in("status", ["active", "paused"]);

  for (const leadId of new Set(fresh.map((r) => r.lead_id))) {
    await db.from("interactions").insert({
      lead_id: leadId,
      kind: "note",
      detail: `${address} hard-bounced (${detail}). Marked Bounced; it will never be emailed again. Look up a different address for this person if they matter.`,
    });
  }
  return fresh.length;
}
