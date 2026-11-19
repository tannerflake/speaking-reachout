import type { SupabaseClient } from "@supabase/supabase-js";
import { looksLikeRealEmail } from "@/lib/utils";
import { verifyEmailAddress } from "@/lib/contacts/verify";
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

export function holdMessage(reason: HoldReason, email?: string | null): string {
  switch (reason) {
    case "no_email":
      return "No valid contact email.";
    case "bounced":
      return `${email ?? "This address"} hard-bounced earlier; it will never be emailed again.`;
    case "invalid":
      return `The email verifier says ${email ?? "this address"} does not exist.`;
    case "needs_verification":
      return `Needs verification: ${email ?? "this address"} was guessed or found without confirmation, and unverified addresses bounce about 1 in 4. Verify it (or set it by hand) before it can be queued.`;
  }
}

/**
 * Try to verify an unverified contact with the configured verifier. Returns
 * the contact's status afterwards. With no verifier configured, or on a
 * provider error, the contact stays as it was (held).
 */
export async function verifyContactIfPossible(
  db: Db,
  contact: { id: string; lead_id?: string; email: string | null; contact_status: ContactStatus },
): Promise<ContactStatus> {
  if (contact.contact_status !== "unverified" || !looksLikeRealEmail(contact.email)) {
    return contact.contact_status;
  }
  let result;
  try {
    result = await verifyEmailAddress(contact.email as string);
  } catch {
    return contact.contact_status;
  }
  if (!result) return contact.contact_status;
  const next: ContactStatus | null =
    result.outcome === "valid" ? "verified" : result.outcome === "invalid" ? "invalid" : null;
  if (next) {
    const { error } = await db.from("contacts").update({ contact_status: next }).eq("id", contact.id);
    // Before migration 0031 'invalid' isn't allowed; park it where nothing sends.
    if (error && next === "invalid") {
      await db.from("contacts").update({ contact_status: "needs_lookup" }).eq("id", contact.id);
    }
  }
  if (contact.lead_id) {
    await db.from("interactions").insert({
      lead_id: contact.lead_id,
      kind: "note",
      detail: `Email check (${result.provider}) for ${contact.email}: ${result.detail || result.outcome}${
        next === "verified"
          ? "; cleared for sending."
          : next === "invalid"
            ? "; the address doesn't exist, so it will not be emailed."
            : "; not conclusive, so it stays held for a human to decide."
      }`,
    });
  }
  return next ?? contact.contact_status;
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
