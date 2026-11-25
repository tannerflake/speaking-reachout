// Who started the conversation with a lead, i.e. who gets the commission.
// Pure helpers (no server imports) so client components can use them too.

import type { AttributionOverride, OutreachChannel } from "@/lib/types";

/**
 * What the badges, filters and dashboard show: "app" (commissionable),
 * "gmail" (first email sent by hand), or "not_app" (an operator override
 * saying it did not come from the app). null = nothing sent, no override.
 */
export type OriginValue = "app" | "gmail" | "not_app";

export interface EffectiveOrigin {
  via: OriginValue | null;
  /** Channel of the earliest sent outreach, ignoring any override. */
  computed: OutreachChannel | null;
  overridden: boolean;
  reason: string | null;
  by: string | null;
  at: string | null;
}

/** Channel of the EARLIEST sent outreach, or null if nothing was sent. */
export function firstSentChannel(
  outreach: Array<{ status: string; sent_at: string | null; sent_via: OutreachChannel }>,
): OutreachChannel | null {
  const first = outreach
    .filter((o) => o.status === "sent" && o.sent_at)
    .sort((a, b) => (a.sent_at as string).localeCompare(b.sent_at as string))[0];
  return first?.sent_via ?? null;
}

/** Override when set, else the computed first-sent channel. */
export function effectiveOrigin(
  lead: {
    attribution_override?: AttributionOverride | null;
    attribution_override_reason?: string | null;
    attribution_override_by?: string | null;
    attribution_override_at?: string | null;
  },
  computed: OutreachChannel | null,
): EffectiveOrigin {
  const o = lead.attribution_override;
  const overridden = o === "app" || o === "not_app";
  return {
    via: overridden ? (o as OriginValue) : computed,
    computed,
    overridden,
    reason: overridden ? (lead.attribution_override_reason ?? null) : null,
    by: overridden ? (lead.attribution_override_by ?? null) : null,
    at: overridden ? (lead.attribution_override_at ?? null) : null,
  };
}

export function originValueLabel(via: OriginValue | null): string {
  if (via === "app") return "App (Tanner)";
  if (via === "gmail") return "Gmail (Jeff)";
  if (via === "not_app") return "Gmail (Jeff)";
  return "Nothing sent yet";
}

/**
 * Activity entries that make up a lead's attribution history: override
 * changes, merges, and referred contacts. Matched by how each note starts.
 */
export const ATTRIBUTION_HISTORY_PREFIXES = [
  "Attribution override",
  "Merged lead",
  "Merged into",
  "Referred contact",
];

export function isAttributionHistory(detail: string | null): boolean {
  return !!detail && ATTRIBUTION_HISTORY_PREFIXES.some((p) => detail.startsWith(p));
}

/** Statuses where a revisit date no longer matters. */
export const REVISIT_TERMINAL_STATUSES = ["closed", "closed_not_me", "junk"];

/** Revisit dates this many days ahead count as "due to revisit". */
export const REVISIT_LOOKAHEAD_DAYS = 14;

/** Local calendar date N days from now as YYYY-MM-DD. */
export function localDatePlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
