"use server";

import { INQUIRY_REFUSAL, inquiryLeadIds } from "@/lib/leads/kind";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getContactResolver } from "@/lib/contacts/resolver";
import {
  ensureLiveWebsite,
  findContactsForLead,
  type MultiFindResult,
} from "@/lib/contacts/findForLead";
import { looksLikeRealEmail } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth/profile";
import type { Contact } from "@/lib/types";

type ContactWithLead = Contact & {
  lead: { name: string; website: string | null; source_url: string | null } | null;
};

/**
 * Resolve a single contact's email via the configured paid provider
 * (Hunter/Apollo). EXPLICIT, operator-triggered — this is the only place the
 * paid provider is hit, and only for one lead at a time. Costs one lookup.
 */
export async function resolveContactEmail(
  contactId: string,
  opts: { force?: boolean } = {},
): Promise<{
  email?: string;
  provider?: string;
  error?: string;
  /** Set when the lookup was skipped because it had already been made. */
  alreadyAttemptedAt?: string;
}> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select("*, lead:leads(name, website, source_url)")
    .eq("id", contactId)
    .single();
  if (!data) return { error: "Contact not found." };

  const contact = data as ContactWithLead;
  if ((await inquiryLeadIds(supabase, [contact.lead_id])).has(contact.lead_id)) {
    return { error: INQUIRY_REFUSAL };
  }
  if (looksLikeRealEmail(contact.email)) {
    return { email: contact.email as string, provider: "existing" };
  }

  const resolver = getContactResolver();
  if (resolver.name === "claude") {
    return {
      error:
        "No email-finding provider is configured. Set CONTACT_RESOLVER=hunter (or apollo) with an API key, or add the email manually.",
    };
  }

  // An earlier "found nothing" against a dead domain says nothing about the
  // real one, so a repaired website re-opens the lookup.
  const repaired = contact.lead
    ? await ensureLiveWebsite(supabase, {
        id: contact.lead_id,
        name: contact.lead.name,
        website: contact.lead.website,
        location: null,
      })
    : null;
  if (repaired && contact.lead) contact.lead.website = repaired;

  // Never silently repeat a lookup the enrich pass (or an earlier click)
  // already made. The operator can still force a re-check.
  if (contact.email_lookup_attempted_at && !opts.force && !repaired) {
    return {
      provider: resolver.name,
      alreadyAttemptedAt: contact.email_lookup_attempted_at,
      error: `${resolver.name} was already checked for this person on ${new Date(
        contact.email_lookup_attempted_at,
      ).toLocaleDateString()} and found nothing. Nothing was spent just now.`,
    };
  }

  const attemptedAt = new Date().toISOString();
  const result = await resolver.resolve({
    name: contact.lead?.name ?? "",
    website: contact.lead?.website ?? null,
    source_url: contact.source_url ?? contact.lead?.source_url ?? null,
    personName: contact.name,
    claudeContact: null,
  });

  if (result.providerError) {
    // The provider failed (quota / key); this was not a real lookup, so the
    // contact is not marked as searched and can be retried later.
    return { provider: resolver.name, error: result.providerError };
  }
  if (!result.email || !looksLikeRealEmail(result.email)) {
    await supabase
      .from("contacts")
      .update({ email_lookup_attempted_at: attemptedAt })
      .eq("id", contactId);
    revalidatePath(`/admin/leads/${contact.lead_id}`);
    return {
      provider: resolver.name,
      error: `No email found via ${resolver.name}. Add it manually below.`,
    };
  }

  const update: Record<string, unknown> = {
    email: result.email,
    contact_status: result.contact_status,
    source_url: result.source_url ?? contact.source_url,
    email_lookup_attempted_at: attemptedAt,
  };
  if (!contact.name && result.name) update.name = result.name;
  if (!contact.role && result.role) update.role = result.role;

  const { error } = await supabase
    .from("contacts")
    .update(update)
    .eq("id", contactId);
  if (error) return { error: error.message };

  await supabase.from("interactions").insert({
    lead_id: contact.lead_id,
    kind: "note",
    detail: `Resolved contact email via ${resolver.name}.`,
  });
  revalidatePath(`/admin/leads/${contact.lead_id}`);
  return { email: result.email, provider: resolver.name };
}

/**
 * Re-look up a contact via the configured paid provider and REPLACE it with the
 * fresh result. Unlike resolveContactEmail, this runs even when the contact
 * already has a (verified) email — for the case where that email bounced / does
 * not exist. EXPLICIT, operator-triggered, one lookup per click. Leaves the
 * existing contact untouched if the provider finds nothing usable.
 */
export async function relookupContact(
  contactId: string,
): Promise<{ email?: string; provider?: string; error?: string }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select("*, lead:leads(name, website, source_url)")
    .eq("id", contactId)
    .single();
  if (!data) return { error: "Contact not found." };

  const contact = data as ContactWithLead;
  if ((await inquiryLeadIds(supabase, [contact.lead_id])).has(contact.lead_id)) {
    return { error: INQUIRY_REFUSAL };
  }

  const resolver = getContactResolver();
  if (resolver.name === "claude") {
    return {
      error:
        "No email-finding provider is configured. Set CONTACT_RESOLVER=hunter (or apollo) with an API key to look up a fresh contact.",
    };
  }

  if (contact.lead) {
    const repaired = await ensureLiveWebsite(supabase, {
      id: contact.lead_id,
      name: contact.lead.name,
      website: contact.lead.website,
      location: null,
    });
    if (repaired) contact.lead.website = repaired;
  }

  const result = await resolver.resolve({
    name: contact.lead?.name ?? "",
    website: contact.lead?.website ?? null,
    source_url: contact.source_url ?? contact.lead?.source_url ?? null,
    claudeContact: null,
  });

  if (result.providerError) return { provider: resolver.name, error: result.providerError };
  if (!result.email || !looksLikeRealEmail(result.email)) {
    return {
      provider: resolver.name,
      error: `No fresh contact found via ${resolver.name}. The existing one was left unchanged — add an email manually instead.`,
    };
  }

  // Replace the contact wholesale with the provider's result. Fall back to the
  // existing name/role only when the provider didn't supply one.
  const { error } = await supabase
    .from("contacts")
    .update({
      name: result.name ?? contact.name,
      role: result.role ?? contact.role,
      email: result.email,
      contact_status: result.contact_status,
      source_url: result.source_url ?? contact.source_url,
    })
    .eq("id", contactId);
  if (error) return { error: error.message };

  const previous = contact.email ? ` (was ${contact.email})` : "";
  await supabase.from("interactions").insert({
    lead_id: contact.lead_id,
    kind: "note",
    detail: `Replaced contact via ${resolver.name}: ${result.email}${previous}.`,
  });
  revalidatePath(`/admin/leads/${contact.lead_id}`);
  return { email: result.email, provider: resolver.name };
}

export interface BulkFindResult {
  /** Leads that got a fresh contact email from the provider. */
  found: number;
  /** Leads skipped because a contact already had a usable email. */
  skipped: number;
  /** Leads where the provider came up empty. */
  notFound: number;
  error?: string;
}

/**
 * Find contact emails for many leads at once via the configured paid provider.
 * EXPLICIT, operator-triggered from the leads list (the UI confirms the number
 * of paid lookups first). Leads that already have a usable contact email are
 * skipped and cost nothing; every other lead is exactly one provider lookup.
 */
export async function bulkFindContacts(
  leadIds: string[],
): Promise<BulkFindResult> {
  const empty = { found: 0, skipped: 0, notFound: 0 };
  if (leadIds.length === 0) return empty;

  const resolver = getContactResolver();
  if (resolver.name === "claude") {
    return {
      ...empty,
      error:
        "No email-finding provider is configured. Set CONTACT_RESOLVER=hunter (or apollo) with an API key.",
    };
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("leads")
    .select("id, name, website, source_url, contacts(*)")
    .in("id", leadIds);
  // Non-booking inquiries never get paid lookups.
  const inquiries = await inquiryLeadIds(supabase, leadIds);

  type LeadRow = {
    id: string;
    name: string;
    website: string | null;
    source_url: string | null;
    contacts: Contact[];
  };
  const leads = ((data as LeadRow[]) ?? []).filter((l) => !inquiries.has(l.id));

  let found = 0;
  let skipped = 0;
  let notFound = 0;
  let providerError: string | null = null;

  // Low concurrency to stay polite to the provider API.
  const queue = [...leads];
  async function worker() {
    for (;;) {
      if (providerError) return;
      const lead = queue.shift();
      if (!lead) return;

      const contacts = lead.contacts ?? [];
      if (contacts.some((c) => looksLikeRealEmail(c.email))) {
        skipped += 1;
        continue;
      }

      const result = await resolver.resolve({
        name: lead.name,
        website: lead.website,
        source_url: lead.source_url,
        claudeContact: null,
      });

      if (result.providerError) {
        // Out of credits / bad key: every later lookup fails the same way.
        providerError = result.providerError;
        break;
      }
      if (!result.email || !looksLikeRealEmail(result.email)) {
        notFound += 1;
        continue;
      }

      // Fill the existing email-less contact row if there is one; otherwise
      // create the lead's first contact.
      const existing = contacts[0];
      if (existing) {
        const update: Record<string, unknown> = {
          email: result.email,
          contact_status: result.contact_status,
          source_url: result.source_url ?? existing.source_url,
        };
        if (!existing.name && result.name) update.name = result.name;
        if (!existing.role && result.role) update.role = result.role;
        const { error } = await supabase
          .from("contacts")
          .update(update)
          .eq("id", existing.id);
        if (error) {
          notFound += 1;
          continue;
        }
      } else {
        const { error } = await supabase.from("contacts").insert({
          lead_id: lead.id,
          name: result.name,
          role: result.role,
          email: result.email,
          contact_status: result.contact_status,
          source_url: result.source_url,
        });
        if (error) {
          notFound += 1;
          continue;
        }
      }

      await supabase.from("interactions").insert({
        lead_id: lead.id,
        kind: "note",
        detail: `Found contact email via ${resolver.name}: ${result.email}.`,
      });
      found += 1;
    }
  }
  await Promise.all([worker(), worker()]);

  revalidatePath("/admin/leads");
  return providerError
    ? { found, skipped, notFound, error: providerError }
    : { found, skipped, notFound };
}

/**
 * Find up to MAX_CONTACTS_PER_LEAD people at one lead (see
 * lib/contacts/findForLead.ts). Runs per lead from the lead page button.
 */
export async function findMultipleContacts(leadId: string): Promise<MultiFindResult> {
  const supabase = await createClient();
  const result = await findContactsForLead(supabase, leadId);
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  return result;
}

/** Manually set a contact's email (operator-confirmed → verified). */
export async function setContactEmail(
  contactId: string,
  email: string,
): Promise<{ error?: string }> {
  const trimmed = email.trim();
  if (!looksLikeRealEmail(trimmed)) {
    return { error: "Enter a valid email address." };
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select("lead_id")
    .eq("id", contactId)
    .single();
  if (!data) return { error: "Contact not found." };
  const leadId = (data as { lead_id: string }).lead_id;

  const { error } = await supabase
    .from("contacts")
    .update({ email: trimmed, contact_status: "verified" })
    .eq("id", contactId);
  if (error) return { error: error.message };

  await supabase.from("interactions").insert({
    lead_id: leadId,
    kind: "note",
    detail: "Contact email set manually.",
  });
  revalidatePath(`/admin/leads/${leadId}`);
  return {};
}

/**
 * Operator confirms an address they checked themselves (e.g. on the org's
 * staff page). The only manual way past the "needs verification" hold.
 */
export async function markContactVerified(contactId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select("lead_id, email, contact_status")
    .eq("id", contactId)
    .single();
  if (!data) return { error: "Contact not found." };
  const row = data as { lead_id: string; email: string | null; contact_status: string };
  if (row.contact_status === "bounced" || row.contact_status === "invalid") {
    return { error: "This address bounced or failed verification; set a different email instead." };
  }
  if (!looksLikeRealEmail(row.email)) return { error: "This contact has no valid email." };
  const { error } = await supabase
    .from("contacts")
    .update({ contact_status: "verified" })
    .eq("id", contactId);
  if (error) return { error: error.message };
  await supabase.from("interactions").insert({
    lead_id: row.lead_id,
    kind: "note",
    detail: `${row.email} marked verified by hand.`,
  });
  revalidatePath(`/admin/leads/${row.lead_id}`);
  revalidatePath("/admin/leads");
  return {};
}

export interface ReferredContactInput {
  name: string;
  email: string;
  role: string | null;
  phone: string | null;
  /** The existing contact on this lead who pointed us to this person. */
  referredById: string;
  note: string | null;
  /** Save even though the email is already a contact on another lead. */
  allowDuplicate?: boolean;
}

export interface ReferredContactResult {
  error?: string;
  /** The email is already a contact on another lead (suggest Merge). */
  duplicate?: { leadId: string; leadName: string; contactName: string | null };
}

/** Escape LIKE wildcards so an email is matched literally (case-insensitive). */
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * "Add referred contact": someone at the org said "talk to X instead". X is
 * saved on THIS lead with referred_by_contact_id, so the lead keeps its
 * attribution (its first sent outreach). Referred contacts are never
 * cold-drafted, bulk-scheduled or followed up automatically; Jeff/Cheryl
 * write to them by hand, and the engagement guard counts the org as in
 * conversation. Requires migration 0034.
 */
export async function addReferredContact(
  leadId: string,
  input: ReferredContactInput,
): Promise<ReferredContactResult> {
  const name = input.name.trim();
  const email = input.email.trim();
  if (!name) return { error: "Name is required." };
  if (!looksLikeRealEmail(email)) return { error: "Enter a valid email address." };
  if (!input.referredById) return { error: "Choose who referred this person." };

  const supabase = await createClient();
  const { data: referrer } = await supabase
    .from("contacts")
    .select("id, lead_id, name, email")
    .eq("id", input.referredById)
    .maybeSingle();
  const ref = referrer as { id: string; lead_id: string; name: string | null; email: string | null } | null;
  if (!ref || ref.lead_id !== leadId) {
    return { error: "The referring contact must be one of this lead's contacts." };
  }

  const { data: existing } = await supabase
    .from("contacts")
    .select("id, lead_id, name, lead:leads(name)")
    .ilike("email", likeLiteral(email));
  type Existing = {
    id: string;
    lead_id: string;
    name: string | null;
    lead: { name: string } | { name: string }[] | null;
  };
  const rows = (existing as Existing[] | null) ?? [];
  if (rows.some((r) => r.lead_id === leadId)) {
    return { error: `${email} is already a contact on this lead.` };
  }
  const elsewhere = rows[0];
  if (elsewhere && !input.allowDuplicate) {
    const lead = Array.isArray(elsewhere.lead) ? elsewhere.lead[0] : elsewhere.lead;
    return {
      duplicate: {
        leadId: elsewhere.lead_id,
        leadName: lead?.name ?? "another lead",
        contactName: elsewhere.name,
      },
    };
  }

  const { error } = await supabase.from("contacts").insert({
    lead_id: leadId,
    name,
    email,
    role: input.role?.trim() || null,
    phone: input.phone?.trim() || null,
    // Given to us by someone at the organization: an operator-entered address.
    contact_status: "verified",
    referred_by_contact_id: ref.id,
  });
  if (error) {
    return {
      error: /referred_by_contact_id|phone/.test(error.message)
        ? "Referred contacts need database migration 0034 to be applied first."
        : error.message,
    };
  }

  const me = await getCurrentUser();
  const note = input.note?.trim();
  await supabase.from("interactions").insert({
    lead_id: leadId,
    kind: "note",
    detail: `Referred contact ${name} <${email}> added (referred by ${ref.name || ref.email || "a contact"}) by ${
      me?.email ?? "unknown user"
    }.${note ? ` Note: ${note}` : ""} Handled by hand: no automated outreach or follow-ups to them.`,
  });
  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  return {};
}
