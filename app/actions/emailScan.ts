"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { scanInboxForReplies, type ScanSummary } from "@/lib/gmail/replyScan";

// Note: a "use server" module must export only async functions. Re-exporting
// the ScanSummary type from here compiles to a runtime reference and crashes
// the production bundle (ReferenceError: ScanSummary is not defined), so
// clients import the type from lib/gmail/replyScan directly.

/**
 * "Scan email" button. The same scan also runs automatically before every
 * follow-up batch; see lib/gmail/replyScan.ts.
 */
export async function scanForReplies(): Promise<ScanSummary> {
  return scanInboxForReplies(createAdminClient());
}
