import { Checker, botRoute, readJson } from "@/lib/bot/http";
import { requireLead } from "@/lib/bot/leads";
import { checkLimits, parseEngagements, parseSourceInbox, requireBody } from "@/lib/bot/schema";
import { activitySummary, newCtx, upsertEngagements } from "@/lib/bot/import";
import { engagementYearList } from "@/lib/engagements";
import type { Booking } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function list(db: Parameters<typeof requireLead>[0], leadId: string): Promise<Booking[]> {
  const { data, error } = await db
    .from("bookings")
    .select("*")
    .eq("lead_id", leadId)
    .order("event_year", { ascending: true, nullsFirst: true })
    .order("event_date", { ascending: true, nullsFirst: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Booking[];
}

/** GET /api/bot/v1/leads/:id/engagements */
export const GET = botRoute<{ id: string }>(async ({ db }, { id }) => {
  const { lead, mergedFrom } = await requireLead(db, id);
  const engagements = await list(db, lead.id);
  return {
    body: {
      ok: true,
      lead_id: lead.id,
      ...(mergedFrom ? { merged_from: mergedFrom } : {}),
      engagement_years: engagementYearList(engagements),
      engagements,
    },
    leadId: lead.id,
    summary: `list engagements: ${engagements.length}`,
  };
});

/** POST /api/bot/v1/leads/:id/engagements {source_inbox, engagements, dry_run?} (upsert) */
export const POST = botRoute<{ id: string }>(async ({ db, bot, req }, { id }) => {
  const body = requireBody(await readJson(req));
  checkLimits(body);
  const c = new Checker();
  const inbox = parseSourceInbox(c, body.source_inbox);
  const dry = c.bool(body.dry_run, "dry_run") ?? false;
  if (!Array.isArray(body.engagements) || body.engagements.length === 0) c.err("engagements", "required non-empty array");
  const engagements = parseEngagements(c, body.engagements);
  c.fail();
  const { lead, mergedFrom } = await requireLead(db, id);
  const ctx = newCtx(db, bot.actor, bot.botName, inbox, dry);
  if (mergedFrom) ctx.changes.push(`redirected from merged lead ${mergedFrom}`);
  const res = await upsertEngagements(ctx, lead.id, engagements);
  const current = dry ? null : await list(db, lead.id);
  return {
    body: {
      ok: true,
      dry_run: dry,
      lead_id: lead.id,
      ...(mergedFrom ? { merged_from: mergedFrom } : {}),
      engagements: { added: res.added, updated: res.updated, ids: res.ids },
      ...(current ? { engagement_years: engagementYearList(current), current } : {}),
      changes: ctx.changes,
      warnings: ctx.warnings,
    },
    leadId: lead.id,
    sourceInbox: inbox,
    summary: activitySummary("engagements", ctx),
  };
});
