import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { runDueFollowups } from "@/lib/followups/run";

export const dynamic = "force-dynamic";
// Each follow-up is one Gmail thread read + one short model call + one send;
// a daily batch can take a few minutes.
export const maxDuration = 300;

/**
 * Daily scheduler entry point (see vercel.json). Vercel Cron calls this with
 * `Authorization: Bearer $CRON_SECRET`; the same header lets you trigger it
 * by hand with curl. Without CRON_SECRET configured the route refuses to run,
 * so it can never be hit anonymously.
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

  const summary = await runDueFollowups();
  return NextResponse.json({ ok: true, ...summary });
}
