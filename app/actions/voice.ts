"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveVoiceProfile, getProcessedMessageIds } from "@/lib/data";
import { GmailReadScopeMissingError, ingestMessages } from "@/lib/gmail/ingest";
import { GmailNotConnectedError } from "@/lib/gmail/send";
import {
  analyzeCorpus,
  NoSentMailError,
  type PriorProfile,
} from "@/lib/claude/voice";
import type { SuggestedRule } from "@/lib/types";

export interface VoiceRunSummary {
  nothingNew?: boolean;
  error?: string;
  version?: number;
  sourceMessageCount?: number;
  newMessages?: number;
  insightsCount?: number;
  suggestedRulesCount?: number;
}

export async function runVoiceAnalysis(): Promise<VoiceRunSummary> {
  try {
    const prior = await getActiveVoiceProfile();
    const processedIds = await getProcessedMessageIds();

    const ingest = await ingestMessages({ processedIds });
    const newCount = ingest.messages.length;

    if (newCount === 0) {
      return prior
        ? { nothingNew: true }
        : { error: "No messages found in the connected mailbox to analyze." };
    }

    const priorProfile: PriorProfile | undefined = prior
      ? {
          tone_summary: prior.tone_summary,
          structure_summary: prior.structure_summary,
          tactics_summary: prior.tactics_summary,
          cadence_summary: prior.cadence_summary,
        }
      : undefined;

    const result = await analyzeCorpus(ingest.messages, priorProfile);

    const admin = createAdminClient();

    // Versioning: next version, deactivate the prior active profile.
    const { data: maxRow } = await admin
      .from("voice_profile")
      .select("version")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion =
      ((maxRow as { version: number } | null)?.version ?? 0) + 1;
    const sourceMessageCount = processedIds.size + newCount;

    await admin
      .from("voice_profile")
      .update({ is_active: false })
      .eq("is_active", true);

    const suggested: SuggestedRule[] = result.suggested_rules.map((r) => ({
      id: randomUUID(),
      rule_type: r.rule_type,
      raw_instruction: r.raw_instruction,
      // Tag origin so these are distinguishable from manual rules.
      structured_value: { ...r.structured_value, origin: "voice_analysis" },
      accepted: false,
    }));

    const { data: inserted, error: insErr } = await admin
      .from("voice_profile")
      .insert({
        version: nextVersion,
        is_active: true,
        tone_summary: result.tone_summary,
        structure_summary: result.structure_summary,
        tactics_summary: result.tactics_summary,
        cadence_summary: result.cadence_summary,
        prompt_injection: result.prompt_injection,
        suggested_rules: suggested,
        source_message_count: sourceMessageCount,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      return { error: insErr?.message ?? "Failed to save voice profile." };
    }
    const profileId = (inserted as { id: string }).id;

    if (result.insights.length) {
      await admin.from("email_insights").insert(
        result.insights.map((i) => ({
          voice_profile_id: profileId,
          category: i.category,
          insight: i.insight,
          example_excerpt: i.example_excerpt,
        })),
      );
    }

    // Record processed message IDs (chunked, ignore duplicates).
    const rows = ingest.messages.map((m) => ({
      gmail_message_id: m.id,
      label: m.isSent
        ? "SENT"
        : m.labels.includes("INBOX")
          ? "INBOX"
          : (m.labels[0] ?? "OTHER"),
      internal_date: m.internalDate,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await admin
        .from("processed_messages")
        .upsert(rows.slice(i, i + 500), {
          onConflict: "gmail_message_id",
          ignoreDuplicates: true,
        });
    }

    revalidatePath("/admin/voice-insights");
    revalidatePath("/admin/settings/tailoring");
    return {
      version: nextVersion,
      sourceMessageCount,
      newMessages: newCount,
      insightsCount: result.insights.length,
      suggestedRulesCount: suggested.length,
    };
  } catch (e) {
    if (
      e instanceof GmailNotConnectedError ||
      e instanceof GmailReadScopeMissingError ||
      e instanceof NoSentMailError
    ) {
      return { error: e.message };
    }
    return { error: e instanceof Error ? e.message : "Analysis failed." };
  }
}

async function loadSuggested(
  profileId: string,
): Promise<{ rules: SuggestedRule[] } | { error: string }> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("voice_profile")
    .select("suggested_rules")
    .eq("id", profileId)
    .maybeSingle();
  if (!data) return { error: "Profile not found." };
  return {
    rules: ((data as { suggested_rules: SuggestedRule[] }).suggested_rules) ?? [],
  };
}

export async function acceptSuggestedRule(
  profileId: string,
  ruleId: string,
): Promise<{ error?: string }> {
  const loaded = await loadSuggested(profileId);
  if ("error" in loaded) return { error: loaded.error };

  const rule = loaded.rules.find((r) => r.id === ruleId);
  if (!rule) return { error: "Rule not found." };
  if (rule.accepted) return {}; // idempotent

  const admin = createAdminClient();
  const { error } = await admin.from("tailoring_rules").insert({
    raw_instruction: rule.raw_instruction,
    rule_type: rule.rule_type,
    structured_value: rule.structured_value,
    is_active: true,
  });
  if (error) return { error: error.message };

  const updated = loaded.rules.map((r) =>
    r.id === ruleId ? { ...r, accepted: true } : r,
  );
  await admin
    .from("voice_profile")
    .update({ suggested_rules: updated })
    .eq("id", profileId);

  revalidatePath("/admin/voice-insights");
  revalidatePath("/admin/settings/tailoring");
  return {};
}

export async function acceptAllSuggestedRules(
  profileId: string,
): Promise<{ accepted: number; error?: string }> {
  const loaded = await loadSuggested(profileId);
  if ("error" in loaded) return { accepted: 0, error: loaded.error };

  const pending = loaded.rules.filter((r) => !r.accepted);
  if (pending.length === 0) return { accepted: 0 };

  const admin = createAdminClient();
  const { error } = await admin.from("tailoring_rules").insert(
    pending.map((r) => ({
      raw_instruction: r.raw_instruction,
      rule_type: r.rule_type,
      structured_value: r.structured_value,
      is_active: true,
    })),
  );
  if (error) return { accepted: 0, error: error.message };

  const updated = loaded.rules.map((r) => ({ ...r, accepted: true }));
  await admin
    .from("voice_profile")
    .update({ suggested_rules: updated })
    .eq("id", profileId);

  revalidatePath("/admin/voice-insights");
  revalidatePath("/admin/settings/tailoring");
  return { accepted: pending.length };
}
