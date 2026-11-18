import type { SupabaseClient } from "@supabase/supabase-js";
import { getActiveRules, getActiveVoiceInjection, getLead } from "@/lib/data";
import { GREETING_LINE, generateOutreach } from "@/lib/claude/outreach";
import { greetingFor, organizationDisplayName } from "@/lib/outreach/orgName";
import {
  checkEngagementGuard,
  markLeadAlreadyInContact,
  summarizeConflicts,
} from "@/lib/outreach/guard";
import { looksLikeRealEmail } from "@/lib/utils";
import type { Contact } from "@/lib/types";

// Works with either the operator's cookie-bound client (server actions) or
// the service-role client (the background enrichment queue).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * Drafting preflight: CRM-level engagement check (no mailbox call) so we
 * don't spend a researched generation on an org we must not email. The
 * operator can acknowledge the conflict to draft anyway; sending still
 * requires a recorded override on the row.
 */
export async function draftingBlocked(
  db: Db,
  leadId: string,
  acknowledged: boolean | undefined,
): Promise<string | null> {
  if (acknowledged) return null;
  const { data: lead } = await db
    .from("leads")
    .select("status")
    .eq("id", leadId)
    .maybeSingle();
  if ((lead as { status: string } | null)?.status === "blocked") {
    return `${BLOCKED_PREFIX} This lead is marked Already in contact. Use "Draft anyway" if this is deliberate.`;
  }
  const guard = await checkEngagementGuard(db, leadId, { skipGmail: true });
  if (!guard.blocked) return null;
  const reason = summarizeConflicts(guard);
  await markLeadAlreadyInContact(db, leadId, reason);
  return `${BLOCKED_PREFIX} ${reason} Use "Draft anyway" if this is deliberate.`;
}

/** How a refusal from the engagement guard starts (callers match on it). */
export const BLOCKED_PREFIX = "Not drafted.";
/** Returned when there is nobody left on the lead to draft for. */
export const NO_TARGETS_ERROR =
  "Every contact with an email already has a draft or a sent email.";

const NAME_TOKEN = "[NAME]";

/**
 * Swap the shared greeting placeholder for one contact: "Dear Susan Krys,",
 * or for a shared inbox with no name, "Dear <organization> team,".
 */
function personalize(body: string, contact: Contact, leadName: string): string {
  const name = contact.name?.trim();
  if (!body.includes(NAME_TOKEN)) return body;
  const greeted = body.replace(
    new RegExp(`^\\s*Dear ${NAME_TOKEN.replace(/[[\]]/g, "\\$&")},[^\\n]*`),
    greetingFor(name, leadName),
  );
  return greeted
    .split(NAME_TOKEN)
    .join(name || organizationDisplayName(leadName) || "your team");
}

/**
 * Contacts on a lead that still need a draft: a real email, no draft or sent
 * email yet, and ONE per email address. Two contact rows can share an inbox
 * (the same person found under two names); only the first gets a draft, and
 * none does if that address was already drafted or emailed through another
 * row, so nobody receives the same pitch twice.
 */
export function draftTargets<C extends { id: string; email: string | null }>(
  contacts: C[],
  outreach: Array<{ contact_id: string | null }>,
): C[] {
  const covered = new Set(
    outreach.map((o) => o.contact_id).filter(Boolean) as string[],
  );
  const usedEmails = new Set(
    contacts
      .filter((c) => covered.has(c.id) && looksLikeRealEmail(c.email))
      .map((c) => (c.email as string).trim().toLowerCase()),
  );
  const targets: C[] = [];
  for (const c of contacts) {
    if (!looksLikeRealEmail(c.email) || covered.has(c.id)) continue;
    const email = (c.email as string).trim().toLowerCase();
    if (usedEmails.has(email)) continue;
    usedEmails.add(email);
    targets.push(c);
  }
  return targets;
}

/**
 * Draft outreach for every contact on a lead that has an email and hasn't been
 * emailed or drafted yet. Runs ONE researched generation (written to be sent
 * individually to several people at the same org), then saves a personalized
 * copy per contact so each can be reviewed and edited before sending.
 */
export async function draftAllForLead(
  db: Db,
  leadId: string,
  oneOff?: string,
  opts?: { acknowledgeConflict?: boolean; timeoutMs?: number },
): Promise<{ created: number; error?: string; styleAdjusted?: boolean }> {
  const lead = await getLead(leadId, db);
  if (!lead) return { created: 0, error: "Lead not found." };
  const blockedReason = await draftingBlocked(db, leadId, opts?.acknowledgeConflict);
  if (blockedReason) return { created: 0, error: blockedReason };

  const targets = draftTargets(lead.contacts, lead.outreach);
  if (targets.length === 0) return { created: 0, error: NO_TARGETS_ERROR };

  const [rules, voiceInjection] = await Promise.all([
    getActiveRules(db),
    getActiveVoiceInjection(db),
  ]);

  const multiInstruction = `This same email will be sent individually to ${targets.length} different people at this organization (roles include: ${targets
    .map((c) => c.role ?? "staff")
    .slice(0, 7)
    .join("; ")}). Keep it about the institution and its programs rather than any one person's job, so it reads naturally for each recipient. Open with exactly "Dear ${NAME_TOKEN}," on the first line; that placeholder is replaced with each recipient's name.`;

  try {
    const gen = await generateOutreach({
      lead,
      contact: null,
      rules,
      oneOffInstruction: oneOff ? `${multiInstruction}\n${oneOff}` : multiInstruction,
      voiceInjection,
      timeoutMs: opts?.timeoutMs,
    });

    // Guarantee the placeholder greeting even if the model ignored it.
    const body = gen.body.includes(NAME_TOKEN)
      ? gen.body
      : gen.body.replace(GREETING_LINE, `Dear ${NAME_TOKEN},\n`);

    // The generation takes a minute; a parallel run (queue worker plus a
    // button click) may have drafted meanwhile. Re-read so the same contact
    // never ends up with two drafts.
    const { data: nowCovered } = await db
      .from("outreach")
      .select("contact_id")
      .eq("lead_id", leadId);
    const fresh = draftTargets(
      targets,
      (nowCovered as Array<{ contact_id: string | null }> | null) ?? [],
    );
    if (fresh.length === 0) return { created: 0, error: NO_TARGETS_ERROR };

    const { error } = await db.from("outreach").insert(
      fresh.map((c) => ({
        lead_id: leadId,
        contact_id: c.id,
        subject: gen.subject,
        body: personalize(body, c, lead.name),
        status: "draft",
      })),
    );
    if (error) return { created: 0, error: error.message };

    return { created: fresh.length, styleAdjusted: gen.styleAdjusted };
  } catch (e) {
    return {
      created: 0,
      error: e instanceof Error ? e.message : "Failed to draft outreach.",
    };
  }
}
