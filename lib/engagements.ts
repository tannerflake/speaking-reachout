// Engagement history helpers (migration 0037). Pure: no server imports, so
// client components (lead rows, chips) can use them too.

import type { Booking, BookingOutcome } from "@/lib/types";

export interface BookedYear {
  year: number;
  /** Every non-canceled engagement that year is still upcoming. */
  upcoming: boolean;
}

type YearRow = Pick<Booking, "event_year" | "outcome">;

/**
 * Distinct years Jeff was booked at a lead: bookings whose outcome is not
 * 'canceled' and whose event_year is known, ascending. A year reads as
 * "upcoming" only when none of its engagements has happened yet.
 */
export function bookedYears(bookings: YearRow[] | null | undefined): BookedYear[] {
  const byYear = new Map<number, boolean>();
  for (const b of bookings ?? []) {
    if (b.outcome === "canceled" || b.event_year == null) continue;
    const upcoming = b.outcome === "upcoming";
    byYear.set(b.event_year, (byYear.get(b.event_year) ?? true) && upcoming);
  }
  return Array.from(byYear.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([year, upcoming]) => ({ year, upcoming }));
}

/** Just the years, ascending (API shape). */
export function engagementYearList(bookings: YearRow[] | null | undefined): number[] {
  return bookedYears(bookings).map((y) => y.year);
}

/** "Any past client": at least one completed engagement. */
export function isPastClient(bookings: YearRow[] | null | undefined): boolean {
  return (bookings ?? []).some((b) => b.outcome === "completed");
}

export const OUTCOME_LABEL: Record<BookingOutcome, string> = {
  completed: "Completed",
  upcoming: "Upcoming",
  canceled: "Canceled",
};

export function formatFeeUsd(fee: number | null | undefined): string | null {
  if (fee == null || Number.isNaN(Number(fee))) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number(fee) % 1 === 0 ? 0 : 2,
  }).format(Number(fee));
}

/** Leads list "Booked year" filter value: a year, "past", or "" (any). */
export function matchesBookedFilter(
  filter: string,
  years: BookedYear[],
  pastClient: boolean,
): boolean {
  if (!filter) return true;
  if (filter === "past") return pastClient;
  const y = Number(filter);
  return Number.isInteger(y) && years.some((b) => b.year === y);
}
