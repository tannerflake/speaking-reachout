import { botRoute } from "@/lib/bot/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/bot/v1/me: key check. */
export const GET = botRoute(async ({ bot }) => ({
  body: { ok: true, bot_name: bot.botName, key_label: bot.keyLabel, key_prefix: bot.keyPrefix },
  summary: "me",
}));
