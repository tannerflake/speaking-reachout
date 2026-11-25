import { Checker, botRoute, readJson } from "@/lib/bot/http";
import { requireLead } from "@/lib/bot/leads";
import { checkLimits, parseMessages, parseSourceInbox, requireBody } from "@/lib/bot/schema";
import { activitySummary, loadContacts, logMessages, newCtx } from "@/lib/bot/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST /api/bot/v1/leads/:id/messages: append correspondence (merges resolved). */
export const POST = botRoute<{ id: string }>(async ({ db, bot, req }, { id }) => {
  const body = requireBody(await readJson(req));
  checkLimits(body);
  const c = new Checker();
  const inbox = parseSourceInbox(c, body.source_inbox);
  const dry = c.bool(body.dry_run, "dry_run") ?? false;
  if (!Array.isArray(body.messages) || body.messages.length === 0) c.err("messages", "required non-empty array");
  const messages = parseMessages(c, body.messages, inbox);
  c.fail();
  const { lead, mergedFrom } = await requireLead(db, id);
  const ctx = newCtx(db, bot.actor, bot.botName, inbox, dry);
  if (mergedFrom) ctx.changes.push(`redirected from merged lead ${mergedFrom}`);
  const book = await loadContacts(ctx, lead.id);
  const res = await logMessages(ctx, lead, book, messages, { revisitExplicit: false });
  if (book.added) ctx.changes.push(`${book.added} contact(s) added`);
  return {
    body: {
      ok: true,
      dry_run: dry,
      lead_id: lead.id,
      ...(mergedFrom ? { merged_from: mergedFrom } : {}),
      messages: res,
      contacts: { added: book.added, updated: book.updated },
      changes: ctx.changes,
      warnings: ctx.warnings,
    },
    leadId: lead.id,
    sourceInbox: inbox,
    summary: activitySummary("messages", ctx, res.duplicates ? [`${res.duplicates} duplicate(s) skipped`] : []),
  };
});
