"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveRules, getExistingLeadKeys } from "@/lib/data";
import { discoverLeads } from "@/lib/claude/discovery";

export interface DiscoverySummary {
  inserted: number;
  failedBatches: number;
  rawCount: number;
  requested: number;
  needsLookup: number;
  error?: string;
}

export async function runDiscovery(
  count: number,
  focus?: string,
): Promise<DiscoverySummary> {
  const requested = Math.max(1, Math.min(Number(count) || 50, 100));
  const focusText = focus?.trim() || undefined;

  try {
    const rules = await getActiveRules();
    const existing = await getExistingLeadKeys();
    const result = await discoverLeads({
      count: requested,
      focus: focusText,
      rules,
      existing,
    });

    const admin = createAdminClient();
    let inserted = 0;
    let needsLookup = 0;

    for (const lead of result.leads) {
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
      if (error || !data) continue;

      const leadId = (data as { id: string }).id;
      inserted += 1;

      const contact = lead.contact;
      await admin.from("contacts").insert({
        lead_id: leadId,
        name: contact?.name ?? null,
        role: contact?.role ?? null,
        email: contact?.email ?? null,
        contact_status: contact?.contact_status ?? "needs_lookup",
        source_url: contact?.source_url ?? null,
      });
      if (!contact?.email || contact.contact_status === "needs_lookup") {
        needsLookup += 1;
      }

      await admin.from("interactions").insert({
        lead_id: leadId,
        kind: "discovered",
        detail: focusText
          ? `Discovered via focus "${focusText}".`
          : "Discovered via Discover.",
      });
    }

    revalidatePath("/leads");
    revalidatePath("/");
    return {
      inserted,
      failedBatches: result.failedBatches,
      rawCount: result.rawCount,
      requested,
      needsLookup,
    };
  } catch (e) {
    return {
      inserted: 0,
      failedBatches: 0,
      rawCount: 0,
      requested,
      needsLookup: 0,
      error: e instanceof Error ? e.message : "Discovery failed.",
    };
  }
}
