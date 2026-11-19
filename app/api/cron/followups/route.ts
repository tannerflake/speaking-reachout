import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { scanRepliesForFollowups } from "@/lib/followups/run";

export const dynamic = "force-dynamic";
// One inbox scan (list + fetch of new inbox mail, a short model call per reply).
export const maxDuration = 300;

/**
 * Daily reply scan (see vercel.json). Follow-ups themselves no longer go out
 * in a morning batch: each one has its own scheduled slot and is sent by the
 * send-queue tick (/api/cron/send-queue), one email at a time. This job reads
 * new replies so organizations that answered are stopped before their slot.
 * Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`; without
 * CRON_SECRET configured the route refuses to run.
 */
export async function GET(request: NextRequest) {
  const secret = getEnv("CRON_SECRET");
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured; follow-up scheduler disabled." },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await scanRepliesForFollowups();
  return NextResponse.json({ ok: true, ...summary });
}
