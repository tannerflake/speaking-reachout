"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { retryRunEnrichment, stopDiscoveryRun } from "@/app/actions/pipeline";

/** Stop a run that is still searching, or re-queue its unfinished leads. */
export function DiscoveryRunActions({
  runId,
  running,
  stopRequested,
  retryable,
}: {
  runId: string;
  running: boolean;
  stopRequested: boolean;
  /** Leads with an emailable contact and no draft, or a failed contact search. */
  retryable: number;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  const button =
    "rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-60";

  if (!running && retryable === 0 && !msg) return null;
  return (
    <div className="flex items-center gap-2">
      {running && (
        <button
          className={button}
          disabled={pending || stopRequested}
          onClick={() =>
            start(async () => {
              const res = await stopDiscoveryRun(runId);
              setMsg(res.error ?? null);
              router.refresh();
            })
          }
        >
          {stopRequested ? "Stopping…" : "Stop run"}
        </button>
      )}
      {!running && retryable > 0 && (
        <button
          className={button}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await retryRunEnrichment(runId);
              setMsg(
                res.error ??
                  (res.queued > 0
                    ? `Queued ${res.queued} lead${res.queued === 1 ? "" : "s"}.`
                    : "Nothing to retry right now."),
              );
              router.refresh();
            })
          }
        >
          {pending
            ? "Queuing…"
            : `Find contacts + draft for ${retryable} unfinished lead${retryable === 1 ? "" : "s"}`}
        </button>
      )}
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </div>
  );
}
