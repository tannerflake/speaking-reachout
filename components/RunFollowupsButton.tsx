"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendDueFollowups } from "@/app/actions/followups";

/**
 * Manual nudge for the send queue: reads new replies, then runs one tick.
 * Emails (first emails and follow-ups) go out one at a time on scheduled,
 * paced slots, so this sends at most one, and only if pacing allows. The
 * same tick runs every minute on its own.
 */
export function RunFollowupsButton({ dueCount }: { dueCount: number }) {
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);
  const router = useRouter();

  function run() {
    setSummary(null);
    start(async () => {
      const res = await sendDueFollowups();
      const scanNote = res.replyError ? ` Reply scan failed: ${res.replyError}` : "";
      if (res.error) setSummary(res.error);
      else if (res.busy) setSummary("The queue is already running; try again in a minute.");
      else {
        const parts: string[] = [];
        if (res.sent) parts.push(`${res.sent} first email sent`);
        if (res.followupsSent) parts.push(`${res.followupsSent} follow-up sent`);
        if (res.followupsStopped) parts.push(`${res.followupsStopped} follow-up${res.followupsStopped === 1 ? "" : "s"} stopped`);
        if (res.rescheduled) parts.push(`${res.rescheduled} moved to a later slot`);
        if (res.errors.length) parts.push(`${res.errors.length} problem${res.errors.length === 1 ? "" : "s"}: ${res.errors[0]}`);
        setSummary(
          (parts.length ? parts.join(", ") + "." : res.waiting ? `Nothing sent: ${res.waiting}` : "Nothing due right now.") +
            scanNote,
        );
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={run}
        disabled={pending}
        title="Emails go out one at a time on paced, business-hours slots. This checks replies and sends the next one if it's due."
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      >
        {pending
          ? "Checking…"
          : dueCount > 0
            ? `Run send queue (${dueCount} follow-up${dueCount === 1 ? "" : "s"} due)`
            : "Run send queue"}
      </button>
      {summary && <span className="text-xs text-zinc-500">{summary}</span>}
    </div>
  );
}
