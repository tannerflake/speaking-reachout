"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { runDiscovery, type DiscoverySummary } from "@/app/actions/discover";

export function DiscoverForm({ activeRules }: { activeRules: string[] }) {
  const [count, setCount] = useState(50);
  const [focus, setFocus] = useState("");
  const [summary, setSummary] = useState<DiscoverySummary | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function run() {
    setSummary(null);
    start(async () => {
      const res = await runDiscovery(count, focus);
      setSummary(res);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
          <div>
            <label className="block text-sm font-medium text-zinc-700">
              Number of leads
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              disabled={pending}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-zinc-400">Default 50, max 100.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700">
              Focus (optional)
            </label>
            <input
              type="text"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              disabled={pending}
              placeholder='e.g. "universities in the Mountain West", "fintech conferences"'
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-zinc-400">
              Steers the search. Active tailoring rules below always apply.
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={run}
            disabled={pending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {pending ? "Discovering…" : "Run Discover"}
          </button>
          {pending && (
            <span className="text-sm text-zinc-500">
              Researching real venues with web search — this can take a minute.
            </span>
          )}
        </div>
      </div>

      {/* Active rules that will apply */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-medium text-zinc-700">
          Active rules applied to this run
        </h3>
        {activeRules.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-400">
            No active tailoring rules.{" "}
            <Link href="/settings/tailoring" className="text-blue-600 hover:underline">
              Add one
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {activeRules.map((r, i) => (
              <li key={i} className="text-sm text-zinc-600">
                • {r}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Result summary */}
      {summary && (
        <div
          className={`rounded-lg border p-4 ${
            summary.error
              ? "border-rose-200 bg-rose-50"
              : "border-emerald-200 bg-emerald-50"
          }`}
        >
          {summary.error ? (
            <p className="text-sm text-rose-700">{summary.error}</p>
          ) : (
            <div className="text-sm text-zinc-800">
              <p className="font-medium">
                Added {summary.inserted} new lead
                {summary.inserted === 1 ? "" : "s"}.
              </p>
              <p className="mt-1 text-zinc-600">
                {summary.needsLookup} need a manual email lookup.
                {summary.failedBatches > 0 &&
                  ` ${summary.failedBatches} batch(es) failed and were skipped.`}
              </p>
              <Link
                href="/leads?status=new"
                className="mt-2 inline-block text-blue-600 hover:underline"
              >
                View new leads →
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
