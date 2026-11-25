import type { SupabaseClient } from "@supabase/supabase-js";
import { INQUIRY_REFUSAL, isInquiryLead } from "@/lib/leads/kind";
import { getContactResolver } from "@/lib/contacts/resolver";
import {
  MAX_CONTACTS_PER_LEAD,
  MAX_CONTACT_ROWS_PER_LEAD,
  findContactsMultiSource,
} from "@/lib/contacts/multiSource";
import { personKey } from "@/lib/contacts/personKey";
import { domainResolves, findRealWebsite } from "@/lib/contacts/website";
import { domainFromUrl, looksLikeRealEmail } from "@/lib/utils";
import type { Contact } from "@/lib/types";

// Works with either the operator's cookie-bound client (server actions) or
// the service-role client (the background enrichment queue).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export interface MultiFindResult {
  added: number;
  withEmail: number;
  sources: string[];
  failed: Array<{ source: string; reason: string }>;
  hunterUsed: boolean;
  error?: string;
}

/**
 * Find up to MAX_CONTACTS_PER_LEAD people at one lead by asking every
 * configured web-search LLM (Claude, OpenAI, Gemini), verifying
 * them against the pages they cite, and filling gaps with Hunter (one domain
 * search plus a per-person lookup for anyone still missing an email). Also
 * resolves any email-less contact already on the lead. Runs per lead, from the
 * lead page button and from auto-enrich after discovery.
 */
export async function findContactsForLead(
  supabase: Db,
  leadId: string,
): Promise<MultiFindResult> {
  const empty = { added: 0, withEmail: 0, sources: [], failed: [], hunterUsed: false };
  const { data } = await supabase
    .from("leads")
    .select(
      "*, contacts(*)",
    )
    .eq("id", leadId)
    .single();
  if (!data) return { ...empty, error: "Lead not found." };
  // Non-booking inquiries never trigger paid contact lookups.
  if (isInquiryLead(data as { kind?: string })) return { ...empty, error: INQUIRY_REFUSAL };

  const lead = data as {
    id: string;
    name: string;
    type: string;
    description: string | null;
    location_region: string | null;
    location_country: string | null;
    website: string | null;
    source_url: string | null;
    contacts: Contact[];
  };
  const existing = lead.contacts ?? [];

  // A dead website domain makes every Hunter lookup come back empty. Fix it
  // first, and re-open the lookups that were wasted on the dead domain.
  const repaired = await ensureLiveWebsite(supabase, {
    ...lead,
    location: [lead.location_region, lead.location_country].filter(Boolean).join(", ") || null,
  });
  if (repaired) {
    lead.website = repaired;
    for (const c of existing) c.email_lookup_attempted_at = null;
  }

  // Contacts already on the lead with a name but no email (typically the one
  // discovery itself surfaced): resolve them through the paid provider now so
  // the operator never has to click "Find email" by hand.
  const filled = await fillMissingEmails(supabase, lead, existing);
  let hunterUsedForExisting = filled > 0;

  // Contacts the provider already failed to find an email for (or blank
  // rows) don't hold a slot, so a no-email org gets a second batch of new
  // people instead of sitting at "7 contacts, no email" forever. The row
  // ceiling still bounds it: counting only emailed contacts used to let
  // every run on a no-email org add another full batch.
  const live = existing.filter(
    (c) => looksLikeRealEmail(c.email) || (c.name && !c.email_lookup_attempted_at),
  ).length;
  const slots = Math.min(
    MAX_CONTACTS_PER_LEAD - live,
    MAX_CONTACT_ROWS_PER_LEAD - existing.length,
  );
  if (slots <= 0) {
    return {
      ...empty,
      hunterUsed: hunterUsedForExisting,
      error:
        existing.length >= MAX_CONTACT_ROWS_PER_LEAD && live === 0
          ? `No usable email found after ${existing.length} contacts; stopped searching this lead.`
          : `This lead already has ${MAX_CONTACTS_PER_LEAD} contacts.`,
    };
  }

  const result = await findContactsMultiSource({
    name: lead.name,
    type: lead.type,
    description: lead.description,
    location:
      [lead.location_region, lead.location_country].filter(Boolean).join(", ") || null,
    website: lead.website,
    source_url: lead.source_url,
    exclude: existing.map((c) => ({ name: c.name, email: c.email })),
    max: slots,
  });

  hunterUsedForExisting = hunterUsedForExisting || result.hunterUsed;
  // Hunter out of searches / bad key: say so wherever this run is reported.
  const hunterFailure = result.failed.find((f) => f.source === "hunter")?.reason;
  if (result.contacts.length === 0) {
    return {
      ...empty,
      sources: result.succeeded,
      failed: result.failed,
      hunterUsed: hunterUsedForExisting,
      error:
        (result.succeeded.length === 0
          ? "None of the contact sources returned results."
          : "No new contacts could be verified for this lead.") +
        (hunterFailure ? ` ${hunterFailure}` : ""),
    };
  }

  // The search takes a minute; another run (auto-enrich plus a button click)
  // may have inserted contacts meanwhile. Re-read and keep only new people
  // that still fit under the cap.
  const { data: current } = await supabase
    .from("contacts")
    .select("name, email")
    .eq("lead_id", lead.id);
  const taken = current ?? [];
  const takenKeys = new Set(taken.map((c) => personKey(c.name ?? "")).filter(Boolean));
  const takenEmails = new Set(
    taken.map((c) => c.email?.toLowerCase()).filter((e): e is string => Boolean(e)),
  );
  const toInsert = result.contacts
    .filter((c) => {
      if (takenKeys.has(personKey(c.name))) return false;
      // One contact per email address on a lead: a second row for the same
      // inbox would get its own draft and the person would be emailed twice.
      const email = c.email?.toLowerCase();
      if (email && takenEmails.has(email)) return false;
      if (email) takenEmails.add(email);
      return true;
    })
    .slice(0, Math.max(0, Math.min(slots, MAX_CONTACT_ROWS_PER_LEAD - taken.length)));
  if (toInsert.length === 0) {
    return {
      ...empty,
      sources: result.succeeded,
      failed: result.failed,
      hunterUsed: hunterUsedForExisting,
      error: "Another contact search already filled this lead.",
    };
  }

  const now = new Date().toISOString();
  const { error } = await supabase.from("contacts").insert(
    toInsert.map((c) => ({
      lead_id: lead.id,
      name: c.name,
      role: c.role,
      email: c.email,
      contact_status: c.contact_status,
      source_url: c.source_url,
      email_lookup_attempted_at: c.lookupAttempted ? now : null,
    })),
  );
  if (error) return { ...empty, error: error.message };

  const withEmail = toInsert.filter((c) => c.email).length;
  const lines = toInsert
    .map((c) => `${c.name}${c.email ? ` <${c.email}>` : ""} [${c.sources.join(", ")}]`)
    .join("; ");
  await supabase.from("interactions").insert({
    lead_id: lead.id,
    kind: "note",
    detail: `Found ${toInsert.length} contacts (${withEmail} with email): ${lines}.${
      hunterFailure ? ` ${hunterFailure}` : ""
    }`,
  });

  return {
    added: toInsert.length,
    withEmail,
    sources: result.succeeded,
    failed: result.failed,
    hunterUsed: hunterUsedForExisting,
    ...(hunterFailure && withEmail === 0 ? { error: hunterFailure } : {}),
  };
}

/**
 * If the lead's website domain does not exist, web-search the real one, save
 * it, and clear lookup marks on the lead's contacts (those "found nothing"
 * results were against the dead domain). Returns the new website when it was
 * repaired, else null. A transient DNS error is never treated as dead.
 */
export async function ensureLiveWebsite(
  supabase: Db,
  lead: { id: string; name: string; website: string | null; location: string | null },
): Promise<string | null> {
  const deadDomain = domainFromUrl(lead.website);
  if (!deadDomain || (await domainResolves(deadDomain)) !== false) return null;

  const website = await findRealWebsite({
    name: lead.name,
    location: lead.location,
    deadDomain,
  });
  if (!website) {
    await supabase.from("interactions").insert({
      lead_id: lead.id,
      kind: "note",
      detail: `Website ${deadDomain} does not exist and the real site could not be found. Fix the website by hand so email lookups can work.`,
    });
    return null;
  }

  const { error } = await supabase
    .from("leads")
    .update({ website })
    .eq("id", lead.id);
  if (error) return null;
  await supabase
    .from("contacts")
    .update({ email_lookup_attempted_at: null })
    .eq("lead_id", lead.id)
    .is("email", null);
  await supabase.from("interactions").insert({
    lead_id: lead.id,
    kind: "note",
    detail: `Website ${deadDomain} does not exist; replaced it with ${website}.`,
  });
  return website;
}

/**
 * Resolve emails for contacts that already exist on a lead but have none.
 * Mutates `contacts` in place so callers see the new emails. Returns the
 * number of paid lookups attempted (0 when no provider is configured).
 */
async function fillMissingEmails(
  supabase: Db,
  lead: { id: string; name: string; website: string | null; source_url: string | null },
  contacts: Contact[],
): Promise<number> {
  const resolver = getContactResolver();
  if (resolver.name === "claude") return 0;

  // Skip anyone the provider has already been asked about; a repeat lookup
  // would just return the same "nothing" and must never happen silently.
  const targets = contacts.filter(
    (c) => c.name && !looksLikeRealEmail(c.email) && !c.email_lookup_attempted_at,
  );
  if (targets.length === 0) return 0;

  const resolvedLines: string[] = [];
  const providerErrors = new Set<string>();
  // Addresses already on the lead. A lookup that lands on one of them would
  // create a second contact for the same inbox, so it is discarded.
  const takenEmails = new Set(
    contacts
      .filter((c) => looksLikeRealEmail(c.email))
      .map((c) => (c.email as string).toLowerCase()),
  );
  await Promise.all(
    targets.map(async (c) => {
      const attemptedAt = new Date().toISOString();
      const result = await resolver.resolve({
        name: lead.name,
        website: lead.website,
        source_url: c.source_url ?? lead.source_url,
        personName: c.name,
        claudeContact: null,
      });
      if (result.providerError) {
        // Provider down or out of credits: not a real lookup, so leave the
        // contact unmarked for a retry and report it once on the lead.
        providerErrors.add(result.providerError);
        return;
      }
      const resolved = looksLikeRealEmail(result.email)
        ? (result.email as string).toLowerCase()
        : null;
      const duplicate = resolved !== null && takenEmails.has(resolved);
      if (resolved && !duplicate) takenEmails.add(resolved);
      if (!resolved || duplicate) {
        await supabase
          .from("contacts")
          .update({ email_lookup_attempted_at: attemptedAt })
          .eq("id", c.id);
        c.email_lookup_attempted_at = attemptedAt;
        return;
      }
      const update: Record<string, unknown> = {
        email: result.email,
        contact_status: result.contact_status,
        source_url: result.source_url ?? c.source_url,
        email_lookup_attempted_at: attemptedAt,
      };
      if (!c.role && result.role) update.role = result.role;
      const { error } = await supabase.from("contacts").update(update).eq("id", c.id);
      if (error) return;
      c.email = result.email;
      c.contact_status = result.contact_status;
      resolvedLines.push(`${c.name} <${result.email}>`);
    }),
  );

  if (resolvedLines.length > 0) {
    await supabase.from("interactions").insert({
      lead_id: lead.id,
      kind: "note",
      detail: `Resolved ${resolvedLines.length} existing contact email(s) via ${resolver.name}: ${resolvedLines.join("; ")}.`,
    });
  }
  for (const msg of providerErrors) {
    console.error(`[contacts] ${lead.name}: ${msg}`);
    await supabase.from("interactions").insert({ lead_id: lead.id, kind: "note", detail: msg });
  }
  return targets.length;
}
