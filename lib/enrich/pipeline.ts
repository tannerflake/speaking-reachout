import type { SupabaseClient } from "@supabase/supabase-js";
import { findContactsForLead } from "@/lib/contacts/findForLead";
import {
  BLOCKED_PREFIX,
  NO_TARGETS_ERROR,
  draftAllForLead,
  draftTargets,
} from "@/lib/outreach/draft";
import type { Contact } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export interface EnrichResult {
  leadId: string;
  contactsAdded: number;
  contactsWithEmail: number;
  draftsCreated: number;
  hunterUsed: boolean;
  /** Contacts with an email that still have no draft after this run. */
  missingDrafts: number;
  /** The engagement guard refused to draft (not worth retrying). */
  blocked?: boolean;
  error?: string;
}

/**
 * The "make this lead ready to send" step: find up to seven contacts
 * (web-search LLMs, then one Hunter domain search for gaps) and draft one
 * personalized email per contact with an address. Runs for ONE lead so each
 * call stays inside function time limits.
 *
 * Contact finding is skipped when the lead already has the maximum number of
 * emailed contacts, and drafting is skipped for contacts that already have a
 * draft or a sent email, so it is safe to re-run. It never reports success
 * while a contact with an email is left without a draft: that comes back as
 * an error so the caller can retry or surface it.
 */
export async function enrichLeadCore(
  db: Db,
  leadId: string,
  opts: { deadline?: number } = {},
): Promise<EnrichResult> {
  const out: EnrichResult = {
    leadId,
    contactsAdded: 0,
    contactsWithEmail: 0,
    draftsCreated: 0,
    hunterUsed: false,
    missingDrafts: 0,
  };

  const found = await findContactsForLead(db, leadId);
  out.contactsAdded = found.added;
  out.contactsWithEmail = found.withEmail;
  out.hunterUsed = found.hunterUsed;
  // "Already has 7 contacts" and "nothing new found" are not failures for the
  // pipeline; drafting can still proceed on whatever contacts exist.

  // Leave the draft whatever time remains before the caller's deadline, so a
  // slow contact search can't push the generation past the function limit.
  const timeoutMs = opts.deadline
    ? Math.max(45_000, Math.min(240_000, opts.deadline - Date.now() - 10_000))
    : undefined;
  const drafted = await draftAllForLead(db, leadId, undefined, { timeoutMs });
  out.draftsCreated = drafted.created;
  if (drafted.error && drafted.created === 0) {
    const noTargets = drafted.error === NO_TARGETS_ERROR;
    if (!noTargets) out.error = drafted.error;
    else if (found.withEmail === 0 && found.added === 0 && found.error) {
      out.error = found.error;
    }
    if (drafted.error.startsWith(BLOCKED_PREFIX)) out.blocked = true;
  }

  // No silent drops: whatever the steps above reported, check the database
  // for contacts that have an email and still no draft.
  const [{ data: contacts }, { data: outreach }] = await Promise.all([
    db.from("contacts").select("*").eq("lead_id", leadId).order("created_at"),
    db.from("outreach").select("contact_id").eq("lead_id", leadId),
  ]);
  out.missingDrafts = draftTargets(
    (contacts as Contact[] | null) ?? [],
    (outreach as Array<{ contact_id: string | null }> | null) ?? [],
  ).length;
  if (out.missingDrafts > 0 && !out.error) {
    out.error = `${out.missingDrafts} contact${
      out.missingDrafts === 1 ? "" : "s"
    } with an email still ${out.missingDrafts === 1 ? "has" : "have"} no draft.`;
  }

  return out;
}
