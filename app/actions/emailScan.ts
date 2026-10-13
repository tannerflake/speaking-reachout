"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { scanInboxForReplies, type ScanSummary } from "@/lib/gmail/replyScan";

export type { ScanSummary };

/**
 * "Scan email" button. The same scan also runs automatically before every
 * follow-up batch; see lib/gmail/replyScan.ts.
 */
export async function scanForReplies(): Promise<ScanSummary> {
  return scanInboxForReplies(createAdminClient());
}
