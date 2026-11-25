import { createHash, randomBytes } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Bot API keys (migration 0037). The raw key is "jfb_" + 43 url-safe chars
 * (32 random bytes, base64url). Only its sha256 hex is stored, plus a short
 * display prefix. The raw key is shown once, at generation, and never logged.
 */
export const BOT_KEY_PREFIX = "jfb_";

export function generateBotKey(): { raw: string; hash: string; prefix: string } {
  const raw = `${BOT_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashBotKey(raw), prefix: raw.slice(0, 10) };
}

export function hashBotKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export interface BotIdentity {
  keyId: string;
  keyLabel: string;
  keyPrefix: string | null;
  botName: string;
  /** Written to interactions.actor / bot_activity: "bot:<name>". */
  actor: string;
}

/**
 * Resolve the bearer key on a request, or null. Never throws and never
 * reveals why a key was refused (wrong format, unknown, revoked all look the
 * same to the caller). The Authorization header is never logged.
 */
export async function authenticateBot(
  db: Admin,
  headers: Headers,
): Promise<BotIdentity | null> {
  const auth = headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  if (!m) return null;
  const raw = m[1];
  if (!raw.startsWith(BOT_KEY_PREFIX) || raw.length < BOT_KEY_PREFIX.length + 43) return null;
  const { data, error } = await db
    .from("bot_api_keys")
    .select("id, label, key_prefix")
    .eq("key_hash", hashBotKey(raw))
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const key = data as { id: string; label: string; key_prefix: string | null };
  // Best effort: a failed timestamp write must not fail the request.
  await db
    .from("bot_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.id)
    .then(
      () => undefined,
      () => undefined,
    );
  const headerName = (headers.get("x-bot-name") ?? "").trim().slice(0, 60);
  const botName = headerName || key.label || "bot";
  return {
    keyId: key.id,
    keyLabel: key.label,
    keyPrefix: key.key_prefix,
    botName,
    actor: `bot:${botName}`,
  };
}
