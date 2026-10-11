import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendDueQueued } from "@/lib/outreach/send";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Drains the throttled send queue (see lib/outreach/send.ts). Scheduled every
 * ten minutes in vercel.json so queued emails keep going out after the
 * operator closes the Leads page. Same bearer-secret guard as the follow-up
 * cron; refuses to run without CRON_SECRET.
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

  // Up to 30 per run: at the 1.5s inter-send pause that is well inside the
  // function limit, and the per-email schedule still governs pacing.
  const summary = await sendDueQueued(createAdminClient(), 30);
  return NextResponse.json({ ok: true, ...summary });
}
