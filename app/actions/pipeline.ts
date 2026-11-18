"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  kickContext,
  kickEnrichWorkers,
  requeueLeads,
} from "@/lib/enrich/queue";
import { draftTargets } from "@/lib/outreach/draft";

/** Ask a running Discover run to stop. It finishes the lead in hand first. */
export async function stopDiscoveryRun(runId: string): Promise<{ error?: string }> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("discovery_runs")
    .update({ cancel_requested: true })
    .eq("id", runId)
    .eq("status", "running");
  return error ? { error: error.message } : {};
}

/**
 * Safety net for the enrichment queue, called by the Discover page while it
 * is open: restarts workers if leads are waiting and none are running (for
 * example after a worker was cut off).
 */
export async function pokeEnrichQueue(): Promise<void> {
  await kickEnrichWorkers(createAdminClient(), kickContext(await headers()));
}

/**
 * Re-queue every lead of a Discover run that still has a contact with an
 * email and no draft, or whose contact search never ran or failed.
 */
export async function retryRunEnrichment(
  runId: string,
): Promise<{ queued: number; error?: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("leads")
    .select("id, enrich_status, contacts(id, email), outreach(contact_id)")
    .eq("discovery_run_id", runId);
  if (error) return { queued: 0, error: error.message };

  type Row = {
    id: string;
    enrich_status: string | null;
    contacts: Array<{ id: string; email: string | null }>;
    outreach: Array<{ contact_id: string | null }>;
  };
  const ids = ((data as Row[] | null) ?? [])
    .filter(
      (l) =>
        l.enrich_status === null ||
        l.enrich_status === "error" ||
        draftTargets(l.contacts ?? [], l.outreach ?? []).length > 0,
    )
    .map((l) => l.id);
  const queued = await requeueLeads(admin, ids);
  if (queued > 0) {
    await kickEnrichWorkers(admin, kickContext(await headers()));
  }
  revalidatePath("/admin/discover");
  return { queued };
}
