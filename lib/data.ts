import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  domainFromUrl,
  looksLikeRealEmail,
  normalizeName,
  orgDomainOfEmail,
  registrableDomain,
} from "@/lib/utils";
import { crmBlockReasons } from "@/lib/outreach/guard";
import { MAX_CONTACT_ROWS_PER_LEAD } from "@/lib/contacts/multiSource";
import type {
  Booking,
  Contact,
  EmailInsight,
  FollowupSequence,
  Interaction,
  Lead,
  LeadStatus,
  LeadType,
  LeadWithRelations,
  Outreach,
  OutreachChannel,
  TailoringRule,
  VoiceProfile,
} from "@/lib/types";
import { LEAD_STATUSES, PIPELINE_STATUSES } from "@/lib/types";

export interface LeadListRow extends Lead {
  contactsCount: number;
  /** True when at least one contact has a usable email address. */
  hasContactEmail: boolean;
  lastActivity: string;
  /** True when the lead has at least one draft (unsent) outreach. */
  hasUnsentDraft: boolean;
  /** Emails to this lead sitting in the send queue (status 'queued'). */
  queuedCount: number;
  /** Contacts with a usable email address. */
  emailableContacts: number;
  /**
   * Of the emailable contacts, how many already have an outreach row (draft,
   * queued, or sent). Matches the rule draftForAllContacts uses to decide who
   * still needs a draft.
   */
  draftedContacts: number;
  /**
   * Channel of the EARLIEST sent outreach to this lead, or null if nothing has
   * been sent. This is who gets the commission: "app" means the operator
   * started the conversation, "gmail" means it was started by hand.
   */
  originatedVia: OutreachChannel | null;
  /**
   * Why the engagement guard refuses this lead (the organization is already
   * in a conversation), or null. Set from the CRM check that blocks drafting
   * and from drafts the send-time mailbox check parked as 'blocked'. Bulk
   * runs skip these instead of retrying them every day.
   */
  blockedReason: string | null;
  /** Every contact search came back without a usable email; stopped looking. */
  contactSearchExhausted: boolean;
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
    .select(
      "*, contacts(id, email), interactions(created_at), outreach(status, sent_via, sent_at, contact_id, error)",
    )
    .order("created_at", { ascending: false });

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.type) query = query.eq("type", filters.type);
  if (filters.country) query = query.eq("location_country", filters.country);
  if (filters.search) query = query.ilike("name", `%${filters.search}%`);

  const { data } = await query;
  type Row = Lead & {
    contacts: { id: string; email: string | null }[];
    interactions: { created_at: string }[];
    outreach: {
      status: string;
      sent_via: OutreachChannel;
      sent_at: string | null;
      contact_id: string | null;
      error: string | null;
    }[];
  };
  const rows = (data as Row[]) ?? [];
  // Only leads nothing has been sent to yet can be stuck behind the guard.
  let crmBlocked = new Map<string, string>();
  try {
    crmBlocked = await crmBlockReasons(
      supabase,
      rows
        .filter((r) => !(r.outreach ?? []).some((o) => o.status === "sent"))
        .map((r) => r.id),
    );
  } catch {
    // Advisory only: the list still renders, and drafting/sending re-check.
  }
  return rows.map((row) => {
    const firstSent = (row.outreach ?? [])
      .filter((o) => o.status === "sent" && o.sent_at)
      .sort((a, b) => (a.sent_at as string).localeCompare(b.sent_at as string))[0];
    const activityTimes = (row.interactions ?? []).map((i) =>
      new Date(i.created_at).getTime(),
    );
    const last = activityTimes.length
      ? new Date(Math.max(...activityTimes)).toISOString()
      : row.updated_at;
    const contacts = row.contacts ?? [];
    const emailable = contacts.filter((c) => looksLikeRealEmail(c.email));
    const covered = new Set(
      (row.outreach ?? []).map((o) => o.contact_id).filter(Boolean) as string[],
    );
    return {
      ...row,
      contactsCount: contacts.length,
      hasContactEmail: emailable.length > 0,
      emailableContacts: emailable.length,
      draftedContacts: emailable.filter((c) => covered.has(c.id)).length,
      lastActivity: last,
      hasUnsentDraft: (row.outreach ?? []).some((o) => o.status === "draft"),
      queuedCount: (row.outreach ?? []).filter((o) => o.status === "queued").length,
      originatedVia: firstSent?.sent_via ?? null,
      blockedReason:
        crmBlocked.get(row.id) ??
        (row.outreach ?? []).find((o) => o.status === "blocked")?.error ??
        null,
      contactSearchExhausted:
        emailable.length === 0 && contacts.length >= MAX_CONTACT_ROWS_PER_LEAD,
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

export async function getLeadFollowups(
  leadId: string,
): Promise<FollowupSequence[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("followup_sequences")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: true });
  return (data as FollowupSequence[]) ?? [];
}

/** Count of follow-ups the scheduler would send right now (dashboard hint). */
export async function getDueFollowupCount(): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from("followup_sequences")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .lte("next_due_at", new Date().toISOString());
  return count ?? 0;
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

// ---- Voice & Insights ------------------------------------------------------

export async function getActiveVoiceProfile(): Promise<VoiceProfile | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("voice_profile")
    .select("*")
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as VoiceProfile) ?? null;
}

export async function getVoiceInsights(
  profileId: string,
): Promise<EmailInsight[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("email_insights")
    .select("*")
    .eq("voice_profile_id", profileId)
    .order("created_at", { ascending: true });
  return (data as EmailInsight[]) ?? [];
}

/** The active learned voice block injected into outreach generation. */
export async function getActiveVoiceInjection(): Promise<string | null> {
  const profile = await getActiveVoiceProfile();
  return profile?.prompt_injection ?? null;
}

/** All processed Gmail message IDs, for incremental-analysis dedup. */
export async function getProcessedMessageIds(): Promise<Set<string>> {
  const admin = createAdminClient();
  const ids = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from("processed_messages")
      .select("gmail_message_id")
      .range(from, from + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data)
      ids.add((row as { gmail_message_id: string }).gmail_message_id);
    if (data.length < pageSize) break;
  }
  return ids;
}

/**
 * All Gmail message IDs the reply scanner has already examined. Kept separate
 * from getProcessedMessageIds (Voice analysis) so the two features never hide
 * inbound mail from each other.
 */
export async function getScannedReplyIds(): Promise<Set<string>> {
  const admin = createAdminClient();
  const ids = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from("reply_scan_messages")
      .select("gmail_message_id")
      .range(from, from + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data)
      ids.add((row as { gmail_message_id: string }).gmail_message_id);
    if (data.length < pageSize) break;
  }
  return ids;
}

/**
 * Existing-organization keys for dedup during discovery. Uses the service-role
 * client so it works from a background context without a user session.
 *
 * Discovery must not resurface an org we already know about, so this pulls from
 * EVERY place an org can live, not just the CRM `leads` table:
 *   - `leads`            — discovered + inbound leads already in the pipeline
 *   - `site_content`     — venues Jeff has spoken at / is booked at (the public
 *                          "Recent & upcoming engagements" list)
 *   - `inbound_leads`    — website form captures, which may not be mirrored into
 *                          `leads` yet (crm_lead_id still null)
 */
export async function getExistingLeadKeys(): Promise<{
  names: Set<string>;
  domains: Set<string>;
  displayNames: string[];
}> {
  const admin = createAdminClient();
  const names = new Set<string>();
  const domains = new Set<string>();
  const displayNames: string[] = [];

  const addName = (name: string | null | undefined) => {
    if (!name) return;
    const key = normalizeName(name);
    if (!key) return;
    if (!names.has(key)) displayNames.push(name);
    names.add(key);
  };

  const [leads, engagements, inbound, contacts] = await Promise.all([
    admin.from("leads").select("name, name_normalized, website"),
    admin
      .from("site_content")
      .select("data")
      .eq("section_key", "engagement"),
    admin.from("inbound_leads").select("organization"),
    admin.from("contacts").select("email"),
  ]);

  // A contact's institutional email identifies the org as well as its
  // website does; without this, "X University" and "Lecture Series at X"
  // can both land in the CRM.
  for (const row of contacts.data ?? []) {
    const d = orgDomainOfEmail((row as { email: string | null }).email);
    if (d) domains.add(d);
  }

  for (const row of leads.data ?? []) {
    const r = row as {
      name: string;
      name_normalized: string | null;
      website: string | null;
    };
    addName(r.name);
    if (r.name_normalized) names.add(r.name_normalized);
    const d = domainFromUrl(r.website);
    if (d) {
      domains.add(d);
      const reg = registrableDomain(d);
      if (reg) domains.add(reg);
    }
  }

  for (const row of engagements.data ?? []) {
    const data = (row as { data: { name?: string | null } | null }).data;
    addName(data?.name);
  }

  for (const row of inbound.data ?? []) {
    addName((row as { organization: string | null }).organization);
  }

  return { names, domains, displayNames };
}

export interface DiscoveryRunLead {
  id: string;
  name: string;
  type: LeadType;
  status: LeadStatus;
  location_country: string | null;
  location_region: string | null;
  contactsCount: number;
  emailableContacts: number;
  draftedContacts: number;
  hasUnsentDraft: boolean;
}

export interface DiscoveryRun {
  id: string;
  created_at: string;
  finished_at: string | null;
  requested: number;
  focus: string | null;
  /** "interrupted" = still marked running after the function timeout. */
  status: "running" | "done" | "error" | "interrupted";
  inserted: number;
  raw_count: number | null;
  failed_batches: number | null;
  error: string | null;
  leads: DiscoveryRunLead[];
}

// Discovery is capped at 300s (maxDuration); a run still "running" well past
// that was cut off before it could record its outcome.
const RUN_STALE_MS = 6 * 60 * 1000;

/**
 * Discover runs from the last `hours`, newest first, each with the leads it
 * inserted and their contact/draft coverage. Empty when migration 0027 is not
 * applied yet.
 */
export async function getRecentDiscoveryRuns(
  hours = 24,
): Promise<DiscoveryRun[]> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("discovery_runs")
    .select(
      "*, leads(id, name, type, status, location_country, location_region, created_at, contacts(id, email), outreach(status, contact_id))",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error || !data) return [];

  type Row = Omit<DiscoveryRun, "leads" | "status"> & {
    status: "running" | "done" | "error";
    leads: Array<
      Pick<
        Lead,
        "id" | "name" | "type" | "status" | "location_country" | "location_region"
      > & {
        created_at: string;
        contacts: { id: string; email: string | null }[];
        outreach: { status: string; contact_id: string | null }[];
      }
    >;
  };
  return (data as Row[]).map((run) => {
    const stale =
      run.status === "running" &&
      Date.now() - new Date(run.created_at).getTime() > RUN_STALE_MS;
    const leads = [...(run.leads ?? [])]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((l) => {
        const contacts = l.contacts ?? [];
        const emailable = contacts.filter((c) => looksLikeRealEmail(c.email));
        const covered = new Set(
          (l.outreach ?? []).map((o) => o.contact_id).filter(Boolean) as string[],
        );
        return {
          id: l.id,
          name: l.name,
          type: l.type,
          status: l.status,
          location_country: l.location_country,
          location_region: l.location_region,
          contactsCount: contacts.length,
          emailableContacts: emailable.length,
          draftedContacts: emailable.filter((c) => covered.has(c.id)).length,
          hasUnsentDraft: (l.outreach ?? []).some((o) => o.status === "draft"),
        };
      });
    return {
      ...run,
      status: stale ? "interrupted" : run.status,
      // The counter is updated per lead, but count the tagged leads too in
      // case a progress write was missed.
      inserted: Math.max(run.inserted, leads.length),
      leads,
    };
  });
}
