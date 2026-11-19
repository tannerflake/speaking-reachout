import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { runSendTick } from "@/lib/outreach/send";
import { scanInboxForReplies } from "@/lib/gmail/replyScan";
import { kickContext, kickEnrichWorkers } from "@/lib/enrich/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The send-queue tick. Sends AT MOST ONE email per call (a queued first email
 * or a follow-up whose slot has come), after the pacing rules in
 * lib/outreach/schedule.ts and every send-time safety check.
 *
 * Triggered every minute by Supabase pg_cron + pg_net (migration 0032): the
 * Vercel Hobby plan only allows daily crons, so the vercel.json entry is just
 * a daily safety net. Also runs while the Leads page is open. Bearer
 * CRON_SECRET required; refuses to run without it.
 */
export async function GET(request: NextRequest) {
  const secret = getEnv("CRON_SECRET");
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured; send queue scheduler disabled." },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const minute = new Date().getUTCMinutes();
  // Every 15 minutes, read new replies first so an organization that just
  // answered is stopped before its next follow-up slot.
  const replyScan = minute % 15 === 0 ? await scanInboxForReplies(admin) : undefined;
  const summary = await runSendTick(admin);
  // Safety net for the contacts + drafts queue: restart workers for any
  // leads left waiting (normally workers chain themselves, see
  // lib/enrich/queue.ts). Every ten minutes is plenty.
  const enrichWorkers =
    minute % 10 === 0 ? await kickEnrichWorkers(admin, kickContext(request.headers)) : undefined;
  return NextResponse.json({ ok: true, ...summary, replyScan, enrichWorkers });
}
