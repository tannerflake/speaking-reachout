import { Checker, botRoute, readJson } from "@/lib/bot/http";
import { requireLead } from "@/lib/bot/leads";
import { parseSourceInbox, requireBody } from "@/lib/bot/schema";
import { activitySummary, applyRevisit, applyStatus, newCtx } from "@/lib/bot/import";
import { LEAD_STATUSES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/bot/v1/leads/:id/status {source_inbox, status, reason,
 * revisit_on?, revisit_note?, dry_run?}. 409 lead_blocked when the lead is
 * blocked (the bot never unblocks). Never starts follow-ups; stops them on
 * positive/terminal statuses.
 */
export const POST = botRoute<{ id: string }>(async ({ db, bot, req }, { id }) => {
  const body = requireBody(await readJson(req));
  const c = new Checker();
  const inbox = parseSourceInbox(c, body.source_inbox);
  const status = c.oneOf(body.status, "status", LEAD_STATUSES, { required: true });
  const reason = c.str(body.reason, "reason", { required: true, max: 2000 });
  const revisitOn = c.date(body.revisit_on, "revisit_on", { nullable: true });
  const revisitNote = c.str(body.revisit_note, "revisit_note", { nullable: true, max: 2000 });
  const dry = c.bool(body.dry_run, "dry_run") ?? false;
  c.fail();
  const { lead, mergedFrom } = await requireLead(db, id);
  const ctx = newCtx(db, bot.actor, bot.botName, inbox, dry);
  if (mergedFrom) ctx.changes.push(`redirected from merged lead ${mergedFrom}`);
  let next = await applyStatus(ctx, lead, status as NonNullable<typeof status>, reason as string, { mode: "endpoint" });
  if (revisitOn !== undefined || revisitNote !== undefined) {
    next = await applyRevisit(ctx, next, revisitOn, revisitNote === undefined ? undefined : revisitNote || null);
  }
  return {
    body: {
      ok: true,
      dry_run: dry,
      lead_id: lead.id,
      ...(mergedFrom ? { merged_from: mergedFrom } : {}),
      previous_status: lead.status,
      status: next.status,
      revisit_on: next.revisit_on ?? null,
      revisit_note: next.revisit_note ?? null,
      changes: ctx.changes,
      warnings: ctx.warnings,
    },
    leadId: lead.id,
    sourceInbox: inbox,
    summary: activitySummary("status", ctx),
  };
});
