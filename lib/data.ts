import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { domainFromUrl } from "@/lib/utils";
import type {
  Booking,
  Contact,
  Interaction,
  Lead,
  LeadStatus,
  LeadType,
  LeadWithRelations,
  Outreach,
  TailoringRule,
} from "@/lib/types";
import { LEAD_STATUSES, PIPELINE_STATUSES } from "@/lib/types";

export interface LeadListRow extends Lead {
  contactsCount: number;
  lastActivity: string;
}

export interface LeadFilters {
  status?: LeadStatus;
  country?: string;
  type?: LeadType;
  search?: string;
}

export async function getPipelineCounts(): Promise<Record<LeadStatus, number>> {
  const supabase = await createClient();
  const { data } = await supabase.from("leads").select("status");
  const counts = Object.fromEntries(
    LEAD_STATUSES.map((s) => [s, 0]),
  ) as Record<LeadStatus, number>;
  for (const row of data ?? []) {
    const s = (row as { status: LeadStatus }).status;
    if (s in counts) counts[s] += 1;
  }
  return counts;
}

export { PIPELINE_STATUSES };

export async function getRecentInteractions(
  limit = 15,
): Promise<Array<Interaction & { lead: { name: string } | null }>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("interactions")
    .select("*, lead:leads(name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data as Array<Interaction & { lead: { name: string } | null }>) ?? [];
}

export async function listLeads(filters: LeadFilters): Promise<LeadListRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from("leads")
    .select("*, contacts(count), interactions(created_at)")
    .order("created_at", { ascending: false });

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.type) query = query.eq("type", filters.type);
  if (filters.country) query = query.eq("location_country", filters.country);
  if (filters.search) query = query.ilike("name", `%${filters.search}%`);

  const { data } = await query;
  type Row = Lead & {
    contacts: { count: number }[];
    interactions: { created_at: string }[];
  };
  return ((data as Row[]) ?? []).map((row) => {
    const activityTimes = (row.interactions ?? []).map((i) =>
      new Date(i.created_at).getTime(),
    );
    const last = activityTimes.length
      ? new Date(Math.max(...activityTimes)).toISOString()
      : row.updated_at;
    return {
      ...row,
      contactsCount: row.contacts?.[0]?.count ?? 0,
      lastActivity: last,
    };
  });
}

export async function listCountries(): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("leads")
    .select("location_country")
    .not("location_country", "is", null);
  const set = new Set<string>();
  for (const row of data ?? []) {
    const c = (row as { location_country: string | null }).location_country;
    if (c) set.add(c);
  }
  return Array.from(set).sort();
}

export async function getLead(id: string): Promise<LeadWithRelations | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("leads")
    .select("*, contacts(*), outreach(*), bookings(*)")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const lead = data as Lead & {
    contacts: Contact[];
    outreach: Outreach[];
    bookings: Booking[];
  };
  return {
    ...lead,
    contacts: (lead.contacts ?? []).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    ),
    outreach: (lead.outreach ?? []).sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    ),
    bookings: (lead.bookings ?? []).sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    ),
  };
}

export async function getLeadInteractions(
  leadId: string,
): Promise<Interaction[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("interactions")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });
  return (data as Interaction[]) ?? [];
}

export async function getActiveRules(): Promise<TailoringRule[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tailoring_rules")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  return (data as TailoringRule[]) ?? [];
}

export async function getAllRules(): Promise<TailoringRule[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tailoring_rules")
    .select("*")
    .order("created_at", { ascending: false });
  return (data as TailoringRule[]) ?? [];
}

/**
 * Existing lead keys for dedup during discovery. Uses the service-role client
 * so it works from a background context without a user session.
 */
export async function getExistingLeadKeys(): Promise<{
  names: Set<string>;
  domains: Set<string>;
  displayNames: string[];
}> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("leads")
    .select("name, name_normalized, website");
  const names = new Set<string>();
  const domains = new Set<string>();
  const displayNames: string[] = [];
  for (const row of data ?? []) {
    const r = row as {
      name: string;
      name_normalized: string | null;
      website: string | null;
    };
    if (r.name_normalized) names.add(r.name_normalized);
    if (r.name) displayNames.push(r.name);
    const d = domainFromUrl(r.website);
    if (d) domains.add(d);
  }
  return { names, domains, displayNames };
}
