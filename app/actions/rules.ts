"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { parseRuleInstruction } from "@/lib/claude/rules";

export interface RuleFormState {
  error?: string;
  ok?: boolean;
}

export async function addRule(
  _prev: RuleFormState,
  formData: FormData,
): Promise<RuleFormState> {
  const raw = String(formData.get("instruction") ?? "").trim();
  if (!raw) return { error: "Enter an instruction." };

  try {
    const { rule_type, structured_value } = await parseRuleInstruction(raw);
    const supabase = await createClient();
    const { error } = await supabase.from("tailoring_rules").insert({
      raw_instruction: raw,
      rule_type,
      structured_value,
    });
    if (error) return { error: error.message };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to add rule." };
  }

  revalidatePath("/settings/tailoring");
  return { ok: true };
}

export async function toggleRule(id: string, isActive: boolean): Promise<void> {
  const supabase = await createClient();
  await supabase
    .from("tailoring_rules")
    .update({ is_active: isActive })
    .eq("id", id);
  revalidatePath("/settings/tailoring");
}

export async function deleteRule(id: string): Promise<void> {
  const supabase = await createClient();
  await supabase.from("tailoring_rules").delete().eq("id", id);
  revalidatePath("/settings/tailoring");
}
