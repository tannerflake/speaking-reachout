import { botRoute, readJson } from "@/lib/bot/http";
import { parseUpsert } from "@/lib/bot/schema";
import { activitySummary, newCtx, runUpsert } from "@/lib/bot/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/bot/v1/leads/upsert: add or update a complete lead in one call
 * (lead fields, contacts, correspondence, engagements). See docs/bot-api.md
 * and lib/bot/import.ts for the rules. Never sends or queues email.
 */
export const POST = botRoute(async ({ db, bot, req }) => {
  const input = parseUpsert(await readJson(req));
  const ctx = newCtx(db, bot.actor, bot.botName, input.source_inbox, input.dry_run);
  const result = await runUpsert(ctx, input);
  return {
    body: result,
    leadId: result.lead_id,
    sourceInbox: input.source_inbox,
    summary: activitySummary("upsert", ctx, result.messages.duplicates ? [`${result.messages.duplicates} duplicate message(s) skipped`] : []),
  };
});
