"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getContactResolver } from "@/lib/contacts/resolver";
import { looksLikeRealEmail } from "@/lib/utils";
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
): Promise<{ email?: string; provider?: string; error?: string }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("contacts")
    .select("*, lead:leads(name, website, source_url)")
    .eq("id", contactId)
    .single();
  if (!data) return { error: "Contact not found." };

  const contact = data as ContactWithLead;
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

  const result = await resolver.resolve({
    name: contact.lead?.name ?? "",
    website: contact.lead?.website ?? null,
    source_url: contact.source_url ?? contact.lead?.source_url ?? null,
    claudeContact: null,
  });

  if (!result.email || !looksLikeRealEmail(result.email)) {
    return {
      provider: resolver.name,
      error: `No email found via ${resolver.name}. Add it manually below.`,
    };
  }

  const update: Record<string, unknown> = {
    email: result.email,
    contact_status: result.contact_status,
    source_url: result.source_url ?? contact.source_url,
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
  revalidatePath(`/leads/${contact.lead_id}`);
  return { email: result.email, provider: resolver.name };
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
  revalidatePath(`/leads/${leadId}`);
  return {};
}
