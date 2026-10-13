import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOrganization } from "@/lib/outreach/guard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/** Stop every active/paused sequence on the given leads. */
export async function stopSequencesForLeads(
  db: Db,
  leadIds: string[],
  reason: string,
): Promise<number> {
  if (leadIds.length === 0) return 0;
  const { data } = await db
    .from("followup_sequences")
    .update({ status: "stopped", stop_reason: reason, next_due_at: null })
    .in("lead_id", leadIds)
    .in("status", ["active", "paused"])
    .select("id");
  return data?.length ?? 0;
}

/** Stop every active/paused sequence on a lead (e.g. status moved on). */
export async function stopSequencesForLead(
  db: Db,
  leadId: string,
  reason: string,
): Promise<void> {
  await stopSequencesForLeads(db, [leadId], reason);
}

/**
 * Stop follow-ups to EVERYONE at the organization a lead belongs to: every
 * contact on this lead and on any sibling lead for the same org (same domain
 * or overlapping name). Follow-ups are only for organizations that have not
 * responded; once anyone there answers, nobody there gets another nudge.
 * Returns the ids of the leads in the organization.
 */
export async function stopFollowupsForOrganization(
  db: Db,
  leadId: string,
  reason: string,
): Promise<string[]> {
  let leadIds = [leadId];
  try {
    const { members } = await resolveOrganization(db, leadId);
    leadIds = members.map((m) => m.id);
  } catch {
    // Org resolution failed: still stop this lead's sequences.
  }
  await stopSequencesForLeads(db, leadIds, reason);
  return leadIds;
}
