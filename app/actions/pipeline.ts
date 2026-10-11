"use server";

import { revalidatePath } from "next/cache";
import { findMultipleContacts } from "@/app/actions/contacts";
import { draftForAllContacts } from "@/app/actions/outreach";

export interface EnrichResult {
  leadId: string;
  contactsAdded: number;
  contactsWithEmail: number;
  draftsCreated: number;
  hunterUsed: boolean;
  error?: string;
}

/**
 * The "make this lead ready to send" step: find up to seven contacts
 * (web-search LLMs, then one Hunter domain search for gaps) and draft one
 * personalized email per contact with an address. Runs for ONE lead so each
 * call stays inside function time limits; the Discover page and the Leads
 * bulk bar call it per lead with a little concurrency.
 *
 * Contact finding is skipped when the lead already has the maximum number of
 * emailed contacts, and drafting is skipped for contacts that already have a
 * draft or a sent email, so it is safe to re-run.
 */
export async function enrichLead(leadId: string): Promise<EnrichResult> {
  const out: EnrichResult = {
    leadId,
    contactsAdded: 0,
    contactsWithEmail: 0,
    draftsCreated: 0,
    hunterUsed: false,
  };

  const found = await findMultipleContacts(leadId);
  out.contactsAdded = found.added;
  out.contactsWithEmail = found.withEmail;
  out.hunterUsed = found.hunterUsed;
  // "Already has 7 contacts" and "nothing new found" are not failures for the
  // pipeline; drafting can still proceed on whatever contacts exist.

  const drafted = await draftForAllContacts(leadId);
  out.draftsCreated = drafted.created;
  if (drafted.error && drafted.created === 0) {
    const noTargets = drafted.error.startsWith("Every contact");
    if (!noTargets) out.error = drafted.error;
    else if (found.withEmail === 0 && found.added === 0 && found.error) {
      out.error = found.error;
    }
  }

  revalidatePath(`/admin/leads/${leadId}`);
  revalidatePath("/admin/leads");
  return out;
}
