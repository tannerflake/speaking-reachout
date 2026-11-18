import { after, NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { enrichLeadNow, kickContext, runEnrichWorker } from "@/lib/enrich/queue";

export const dynamic = "force-dynamic";
// One lead per invocation: a multi-provider contact search plus a researched
// draft is a minute or two, occasionally more.
export const maxDuration = 300;

/** The operator's session, or the server's own bearer secret (queue workers). */
async function authorized(request: NextRequest): Promise<boolean> {
  const secret = getEnv("CRON_SECRET");
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) {
    return true;
  }
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return Boolean(data.user);
  } catch {
    return false;
  }
}

/**
 * Find contacts + draft outreach ("enrichment"). Two modes:
 *
 *   { worker: true }  A queue worker (see lib/enrich/queue.ts). Answers 202 at
 *                     once, then claims one pending lead and processes it
 *                     after the response, so nothing depends on the caller
 *                     (or any browser tab) staying connected.
 *   { leadId }        Process this lead now and return the result. Used by
 *                     the Leads page bulk actions; unlike a server action,
 *                     several of these run in parallel.
 */
export async function POST(request: NextRequest) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    worker?: unknown;
    leadId?: unknown;
  };
  const admin = createAdminClient();

  if (body.worker === true) {
    const ctx = kickContext(request.headers);
    after(async () => {
      try {
        await runEnrichWorker(admin, ctx);
      } catch (e) {
        console.error(`[enrich] worker crashed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  if (typeof body.leadId !== "string" || !body.leadId) {
    return NextResponse.json({ error: "leadId is required." }, { status: 400 });
  }
  const result = await enrichLeadNow(admin, body.leadId);
  revalidatePath(`/admin/leads/${body.leadId}`);
  revalidatePath("/admin/leads");
  return NextResponse.json(result);
}
