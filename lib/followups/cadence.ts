import type { LeadStatus } from "@/lib/types";

/**
 * Follow-up cadence: days to wait AFTER the previous email in the thread
 * before sending follow-up N. Widening gaps (4 → 7 → 10 days, i.e. roughly
 * day 4, day 11, day 21) match the consensus of cold-outreach benchmarks:
 * most replies arrive within the first two follow-ups, each later touch
 * earns fewer replies and more spam complaints, and three follow-ups is
 * where the curve flattens.
 */
export const FOLLOWUP_GAP_DAYS: Record<number, number> = { 1: 4, 2: 7, 3: 10 };
export const MAX_FOLLOWUPS = 3;

/**
 * Lead statuses in which an automated follow-up is still appropriate. Any
 * other status (interested, booked, not_interested, junk, ...) means a human
 * or a reply has moved the lead on, and the sequence must stop.
 */
export const FOLLOWUP_ELIGIBLE_STATUSES: LeadStatus[] = [
  "reached_out",
  "followup_1",
  "followup_2",
];

export function followupStatusForStep(step: number): LeadStatus {
  return `followup_${Math.min(Math.max(step, 1), 3)}` as LeadStatus;
}

/** 0 for reached_out/new, N for followup_N; terminal statuses return -1. */
export function stepOfStatus(status: LeadStatus): number {
  const m = /^followup_(\d)$/.exec(status);
  if (m) return Number(m[1]);
  return status === "reached_out" || status === "new" ? 0 : -1;
}

/**
 * When follow-up `step` becomes due, given when the previous email went out.
 * Lands on a weekday (a Saturday/Sunday due date rolls to Monday) and is
 * normalized to the start of that UTC day so the daily scheduler, which runs
 * mid-morning US time, sends it on the intended day.
 */
export function computeDueAt(previousSentAt: Date, step: number): Date {
  const gap = FOLLOWUP_GAP_DAYS[step] ?? FOLLOWUP_GAP_DAYS[MAX_FOLLOWUPS];
  return weekdayAfter(previousSentAt, gap);
}

/** `days` after `from`, rolled forward off weekends, at start of UTC day. */
export function weekdayAfter(from: Date, days: number): Date {
  const due = new Date(from.getTime());
  due.setUTCDate(due.getUTCDate() + days);
  due.setUTCHours(0, 0, 0, 0);
  const dow = due.getUTCDay(); // 0 = Sun, 6 = Sat
  if (dow === 6) due.setUTCDate(due.getUTCDate() + 2);
  else if (dow === 0) due.setUTCDate(due.getUTCDate() + 1);
  return due;
}
