"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scanForReplies, type ScanSummary } from "@/app/actions/emailScan";

function summarize(s: ScanSummary): string {
  if (s.error) return s.error;
  if (s.nothingNew) return "No new replies found.";
  const parts: string[] = [];
  if (s.replies) parts.push(`${s.replies} repl${s.replies === 1 ? "y" : "ies"}`);
  if (s.bounces) parts.push(`${s.bounces} bounce${s.bounces === 1 ? "" : "s"}`);
  const found = parts.length ? parts.join(", ") : "No responses";
  const updated = s.leadsUpdated
    ? ` — ${s.leadsUpdated} lead${s.leadsUpdated === 1 ? "" : "s"} updated`
    : "";
  return `${found}${updated}.`;
}

export function ScanEmailButton({
  variant = "primary",
}: {
  variant?: "primary" | "secondary";
}) {
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const router = useRouter();

  function run() {
    setSummary(null);
    start(async () => {
      const res = await scanForReplies();
      setSummary(res);
      router.refresh();
    });
  }

  const cls =
    variant === "primary"
      ? "rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
      : "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={run} disabled={pending} className={cls}>
        {pending ? "Scanning email…" : "Scan email for updates"}
      </button>
      {summary && (
        <span
          className={`text-xs ${summary.error ? "text-red-600" : "text-zinc-500"}`}
        >
          {summarize(summary)}
        </span>
      )}
    </div>
  );
}
