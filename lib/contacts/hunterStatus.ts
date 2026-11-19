import { getEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/utils";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  HunterApiError,
  hunterAccount,
  hunterErrorText,
  type HunterAccount,
} from "@/lib/contacts/hunter";

/**
 * Is Hunter able to find emails right now? Reads Hunter's free Account
 * endpoint (searches used / available) plus the latest Hunter call in
 * api_usage, so a quota or key failure shows up as a warning instead of
 * contacts silently arriving without emails.
 */

/** Warn when fewer searches than this remain (HUNTER_LOW_SEARCHES overrides). */
export function hunterLowThreshold(): number {
  const n = Number(getEnv("HUNTER_LOW_SEARCHES"));
  return Number.isFinite(n) && n > 0 ? n : 150;
}

export interface HunterStatus {
  configured: boolean;
  account: HunterAccount | null;
  /** Plain-English warning to show, or null when Hunter is healthy. */
  warning: string | null;
  /** "error" = Hunter is failing now; "low" = still working, running out. */
  level: "ok" | "low" | "error";
}

// Pages that auto-refresh (Discover) would otherwise hit Hunter every few
// seconds; the account numbers barely move within a minute.
let cached: { at: number; status: HunterStatus } | null = null;
const CACHE_MS = 60_000;

export async function getHunterStatus(): Promise<HunterStatus> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  const status = await readHunterStatus();
  cached = { at: Date.now(), status };
  return status;
}

async function readHunterStatus(): Promise<HunterStatus> {
  const key = getEnv("HUNTER_API_KEY");
  if (!key) return { configured: false, account: null, warning: null, level: "ok" };

  let account: HunterAccount | null = null;
  let accountError: string | null = null;
  try {
    account = await hunterAccount(key);
  } catch (e) {
    accountError =
      e instanceof HunterApiError
        ? hunterErrorText(e)
        : `Could not read the Hunter account: ${e instanceof Error ? e.message : String(e)}`;
  }

  // The most recent Hunter call. If it failed on quota or the key, that is
  // what contact finding is hitting right now.
  let lastCallError: string | null = null;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("api_usage")
      .select("ok, error, created_at")
      .like("model", "hunter/%")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = data as { ok: boolean; error: string | null; created_at: string } | null;
    if (row && !row.ok && /^(quota|auth)\b/.test(row.error ?? "")) {
      lastCallError = `The last Hunter lookup (${formatDateTime(row.created_at)}) failed: ${row.error}.`;
    }
  } catch {
    // api_usage unreadable: rely on the account check alone
  }

  const threshold = hunterLowThreshold();
  if (accountError || (lastCallError && (!account || account.searchesLeft === 0))) {
    return {
      configured: true,
      account,
      level: "error",
      warning: [accountError, lastCallError].filter(Boolean).join(" "),
    };
  }
  if (account && account.searchesLeft === 0) {
    return {
      configured: true,
      account,
      level: "error",
      warning: `Hunter is out of searches (${account.searchesUsed} of ${account.searchesAvailable} used${
        account.resetDate ? `; resets ${account.resetDate}` : ""
      }). New contacts will arrive without emails until it resets or the plan is upgraded.`,
    };
  }
  if (account && account.searchesLeft < threshold) {
    return {
      configured: true,
      account,
      level: "low",
      warning: `Hunter is running low: ${account.searchesLeft} searches left (${account.searchesUsed} of ${account.searchesAvailable} used${
        account.resetDate ? `; resets ${account.resetDate}` : ""
      }). Each new organization uses about 1 to 8.`,
    };
  }
  return { configured: true, account, warning: null, level: "ok" };
}
