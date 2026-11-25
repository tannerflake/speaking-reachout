import { BotError, botRoute } from "@/lib/bot/http";
import { BOOKING_OUTCOMES, type Booking, type BookingOutcome } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/bot/v1/engagements?year=2025&outcome=completed
 * Engagements across all leads with the lead's name and status ("what did
 * Jeff do in 2025"). Merged-away leads are excluded.
 */
export const GET = botRoute(async ({ db, url }) => {
  const yearRaw = url.searchParams.get("year");
  const outcome = url.searchParams.get("outcome");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 500, 1), 1000);
  const year = yearRaw ? Number(yearRaw) : null;
  if (yearRaw && (!Number.isInteger(year) || (year as number) < 1990 || (year as number) > 2100)) {
    throw new BotError(400, { error: "validation_failed", fields: [{ path: "year", message: "must be a year like 2025" }] }, "engagements: bad year");
  }
  if (outcome && !(BOOKING_OUTCOMES as string[]).includes(outcome)) {
    throw new BotError(400, { error: "validation_failed", fields: [{ path: "outcome", message: `must be one of: ${BOOKING_OUTCOMES.join(", ")}` }] }, "engagements: bad outcome");
  }
  let q = db
    .from("bookings")
    .select("*, lead:leads(id, name, status, kind, merged_into_id)")
    .order("event_year", { ascending: true, nullsFirst: false })
    .order("event_date", { ascending: true, nullsFirst: false })
    .limit(limit);
  if (year != null) q = q.eq("event_year", year);
  if (outcome) q = q.eq("outcome", outcome as BookingOutcome);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  type Row = Booking & { lead: { id: string; name: string; status: string; kind?: string; merged_into_id: string | null } | null };
  const rows = ((data ?? []) as unknown as Row[]).filter((r) => !r.lead?.merged_into_id);
  return {
    body: {
      ok: true,
      count: rows.length,
      engagements: rows.map(({ lead, ...b }) => ({
        ...b,
        lead_name: lead?.name ?? null,
        lead_status: lead?.status ?? null,
        lead_kind: lead?.kind ?? null,
      })),
    },
    summary: `list engagements${year != null ? ` year=${year}` : ""}${outcome ? ` outcome=${outcome}` : ""}: ${rows.length}`,
  };
});
