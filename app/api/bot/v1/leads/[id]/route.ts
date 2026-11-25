import { botRoute } from "@/lib/bot/http";
import { fullLeadView } from "@/lib/bot/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/bot/v1/leads/:id[?bodies=1]: full lead, merges resolved. */
export const GET = botRoute<{ id: string }>(async ({ db, url }, { id }) => {
  const bodies = ["1", "true"].includes(url.searchParams.get("bodies") ?? "");
  const view = await fullLeadView(db, id, { bodies });
  return {
    body: { ok: true, ...view },
    leadId: view.lead.id,
    summary: `get lead ${view.lead.name}${view.merged_from ? " (via merged id)" : ""}`,
  };
});
