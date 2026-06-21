import { createAdminClient } from "@/lib/supabase/admin";
import type { ContactStatus, DiscoveredLead, LeadType } from "@/lib/types";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface DiscoverySummary {
  inserted: number;
  failedBatches: number;
  rawCount: number;
  requested: number;
  needsLookup: number;
  error?: string;
}

/** Shape streamed to the client as each lead lands. */
export interface InsertedLead {
  id: string;
  name: string;
  type: LeadType;
  location_country: string | null;
  location_region: string | null;
  website: string | null;
  contact_status: ContactStatus;
  needsLookup: boolean;
}

/**
 * Persist one discovered lead (+ its contact + a "discovered" interaction).
 * Returns a compact row for streaming, or null if the lead insert failed.
 */
export async function insertDiscoveredLead(
  admin: AdminClient,
  lead: DiscoveredLead,
  detail: string,
): Promise<InsertedLead | null> {
  const { data, error } = await admin
    .from("leads")
    .insert({
      name: lead.name,
      type: lead.type,
      description: lead.description,
      location_country: lead.location_country || null,
      location_region: lead.location_region,
      website: lead.website,
      source_url: lead.source_url,
      fit_rationale: lead.fit_rationale,
      suggested_topics: lead.suggested_topics,
      status: "new",
    })
    .select("id")
    .single();
  if (error || !data) return null;

  const leadId = (data as { id: string }).id;
  const contact = lead.contact;
  const contactStatus: ContactStatus = contact?.contact_status ?? "needs_lookup";

  await admin.from("contacts").insert({
    lead_id: leadId,
    name: contact?.name ?? null,
    role: contact?.role ?? null,
    email: contact?.email ?? null,
    contact_status: contactStatus,
    source_url: contact?.source_url ?? null,
  });

  await admin.from("interactions").insert({
    lead_id: leadId,
    kind: "discovered",
    detail,
  });

  return {
    id: leadId,
    name: lead.name,
    type: lead.type,
    location_country: lead.location_country || null,
    location_region: lead.location_region,
    website: lead.website,
    contact_status: contactStatus,
    needsLookup: !contact?.email || contactStatus === "needs_lookup",
  };
}
