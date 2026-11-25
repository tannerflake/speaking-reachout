"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUser } from "@/lib/auth/profile";
import { generateBotKey } from "@/lib/bot/auth";

// Settings > Bot access. Keys live in bot_api_keys (service role only); the
// raw key is returned exactly once from generate/rotate and never stored.

const PATH = "/admin/settings/bot-access";

async function requireAdmin(): Promise<string> {
  const me = await getCurrentUser();
  if (!me || me.role !== "crm_admin") throw new Error("Not allowed.");
  return me.email ?? me.id;
}

export interface NewKeyResult {
  error?: string;
  /** Raw key: show once, never persist client-side. */
  rawKey?: string;
  prefix?: string;
  revoked?: number;
}

async function insertKey(label: string, by: string): Promise<{ id: string; raw: string; prefix: string }> {
  const { raw, hash, prefix } = generateBotKey();
  const { data, error } = await createAdminClient()
    .from("bot_api_keys")
    .insert({ label, key_hash: hash, key_prefix: prefix, created_by: by })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not save the key.");
  return { id: (data as { id: string }).id, raw, prefix };
}

function cleanLabel(label: string): string | null {
  const l = label.trim().slice(0, 80);
  return l || null;
}

export async function generateBotApiKey(label: string): Promise<NewKeyResult> {
  try {
    const by = await requireAdmin();
    const l = cleanLabel(label);
    if (!l) return { error: "Give the key a label (e.g. Jeff's bot)." };
    const k = await insertKey(l, by);
    revalidatePath(PATH);
    return { rawKey: k.raw, prefix: k.prefix };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed." };
  }
}

/** New key, then revoke every other active key. Needs "ROTATE" typed. */
export async function rotateBotApiKeys(label: string, confirm: string): Promise<NewKeyResult> {
  try {
    const by = await requireAdmin();
    if (confirm.trim() !== "ROTATE") return { error: 'Type ROTATE to confirm.' };
    const l = cleanLabel(label);
    if (!l) return { error: "Give the new key a label." };
    const k = await insertKey(l, by);
    const { data, error } = await createAdminClient()
      .from("bot_api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .is("revoked_at", null)
      .neq("id", k.id)
      .select("id");
    revalidatePath(PATH);
    if (error) return { rawKey: k.raw, prefix: k.prefix, error: `New key created, but revoking old keys failed: ${error.message}` };
    return { rawKey: k.raw, prefix: k.prefix, revoked: data?.length ?? 0 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed." };
  }
}

/** Revoke one key. Needs "REVOKE" typed. */
export async function revokeBotApiKey(id: string, confirm: string): Promise<{ error?: string }> {
  try {
    await requireAdmin();
    if (confirm.trim() !== "REVOKE") return { error: "Type REVOKE to confirm." };
    const { error } = await createAdminClient()
      .from("bot_api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .is("revoked_at", null);
    if (error) return { error: error.message };
    revalidatePath(PATH);
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed." };
  }
}
