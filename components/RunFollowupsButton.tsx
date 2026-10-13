"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendDueFollowups } from "@/app/actions/followups";

/**
 * Manual trigger for the follow-up scheduler. The same run happens
 * automatically every weekday morning via Vercel Cron; this is for "send
 * today's batch now" or for environments without cron.
 */
export function RunFollowupsButton({ dueCount }: { dueCount: number }) {
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);
  const router = useRouter();

  function run() {
    setSummary(null);
    start(async () => {
      const res = await sendDueFollowups();
      const scan = res.replyScan;
      const scanNote = scan?.error
        ? ` Reply scan failed: ${scan.error}`
        : scan?.replies
          ? ` ${scan.replies} new repl${scan.replies === 1 ? "y" : "ies"} found; those organizations won't get follow-ups.`
          : "";
      if (res.error) setSummary(res.error);
      else if (res.checked === 0) setSummary(`No follow-ups due today.${scanNote}`);
      else {
        const parts = [`${res.sent} sent`];
        if (res.stopped) parts.push(`${res.stopped} stopped`);
        if (res.errors.length) parts.push(`${res.errors.length} failed`);
        setSummary(parts.join(", ") + "." + scanNote);
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      >
        {pending
          ? "Sending follow-ups…"
          : dueCount > 0
            ? `Send ${dueCount} due follow-up${dueCount === 1 ? "" : "s"}`
            : "Send due follow-ups"}
      </button>
      {summary && <span className="text-xs text-zinc-500">{summary}</span>}
    </div>
  );
}
