"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TypeBadge, ContactStatusBadge } from "@/components/Badge";
import { enrichLead, type EnrichResult } from "@/app/actions/pipeline";
import type {
  DiscoverySummary,
  InsertedLead,
} from "@/lib/discovery/persist";

type EnrichState =
  | { phase: "waiting" }
  | { phase: "working" }
  | { phase: "done"; result: EnrichResult }
  | { phase: "error"; message: string };

// How many leads get contacts + drafts at once. Each is a minute or two of
// web-search model calls, so two in flight keeps the run moving without
// hammering the providers.
const ENRICH_CONCURRENCY = 2;

export function DiscoverForm({ activeRules }: { activeRules: string[] }) {
  const [count, setCount] = useState(5);
  const [focus, setFocus] = useState("");
  const [running, setRunning] = useState(false);
  const [leads, setLeads] = useState<InsertedLead[]>([]);
  const [summary, setSummary] = useState<DiscoverySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoEnrich, setAutoEnrich] = useState(true);
  const [enrich, setEnrich] = useState<Record<string, EnrichState>>({});
  const [enriching, setEnriching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Leads waiting for contacts + drafts, and how many workers are running.
  const enrichQueue = useRef<string[]>([]);
  const enrichActive = useRef(0);
  const router = useRouter();

  /** Pull leads off the enrich queue until it is empty. */
  function pumpEnrich() {
    while (
      enrichActive.current < ENRICH_CONCURRENCY &&
      enrichQueue.current.length > 0
    ) {
      const id = enrichQueue.current.shift() as string;
      enrichActive.current += 1;
      setEnriching(true);
      setEnrich((prev) => ({ ...prev, [id]: { phase: "working" } }));
      enrichLead(id)
        .then((result) => {
          setEnrich((prev) => ({
            ...prev,
            [id]: result.error
              ? { phase: "error", message: result.error }
              : { phase: "done", result },
          }));
        })
        .catch((e: unknown) => {
          setEnrich((prev) => ({
            ...prev,
            [id]: {
              phase: "error",
              message: e instanceof Error ? e.message : "Failed.",
            },
          }));
        })
        .finally(() => {
          enrichActive.current -= 1;
          if (enrichQueue.current.length === 0 && enrichActive.current === 0) {
            setEnriching(false);
            router.refresh();
          }
          pumpEnrich();
        });
    }
  }

  function scheduleEnrich(id: string) {
    setEnrich((prev) => ({ ...prev, [id]: { phase: "waiting" } }));
    enrichQueue.current.push(id);
    pumpEnrich();
  }

  async function run() {
    setRunning(true);
    setLeads([]);
    setSummary(null);
    setError(null);
    setEnrich({});
    enrichQueue.current = [];

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count, focus }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Discovery request failed (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read NDJSON: one JSON event per line, flushed as leads are generated.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          handleEvent(line);
        }
      }
      if (buffer.trim()) handleEvent(buffer.trim());

      router.refresh();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : "Discovery failed.");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleEvent(line: string) {
    let evt: {
      type: "lead" | "done" | "error";
      lead?: InsertedLead;
      summary?: DiscoverySummary;
      error?: string;
    };
    try {
      evt = JSON.parse(line);
    } catch {
      return; // ignore a malformed line rather than blowing up the run
    }
    if (evt.type === "lead" && evt.lead) {
      setLeads((prev) => [...prev, evt.lead as InsertedLead]);
      // Start finding contacts + drafting the moment the lead lands, while
      // discovery keeps streaming the rest.
      if (autoEnrich) scheduleEnrich(evt.lead.id);
    } else if (evt.type === "done" && evt.summary) {
      setSummary(evt.summary);
    } else if (evt.type === "error") {
      setError(evt.error ?? "Discovery failed.");
    }
  }

  function stop() {
    abortRef.current?.abort();
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
              disabled={running}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-zinc-400">Default 5, max 100.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700">
              Focus (optional)
            </label>
            <input
              type="text"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              disabled={running}
              placeholder='e.g. "universities in the Mountain West", "fintech conferences"'
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-zinc-400">
              Steers the search. Active tailoring rules below always apply.
            </p>
          </div>
        </div>

        <label className="mt-3 flex items-start gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={autoEnrich}
            onChange={(e) => setAutoEnrich(e.target.checked)}
            disabled={running}
            className="mt-0.5"
          />
          <span>
            Find contacts and draft outreach for each lead as it is found
            <span className="block text-xs text-zinc-400">
              Up to seven contacts per lead from the web-search models, plus one
              paid Hunter lookup per lead where needed, then one draft per
              contact. Leads arrive ready to send from the Leads page.
            </span>
          </span>
        </label>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={run}
            disabled={running}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {running ? "Discovering…" : "Run Discover"}
          </button>
          {running && (
            <>
              <button
                onClick={stop}
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50"
              >
                Stop
              </button>
              <span className="text-sm text-zinc-500">
                Researching real venues — {leads.length} of {count} found so far…
              </span>
            </>
          )}
        </div>
      </div>

      {/* Live results — leads appear here as they're generated */}
      {leads.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="text-sm font-medium text-zinc-700">
            New leads {running && "(streaming in…)"}
          </h3>
          <ul className="mt-2 divide-y divide-zinc-100">
            {leads.map((l) => (
              <li
                key={l.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <Link
                    href={`/admin/leads/${l.id}`}
                    className="font-medium text-blue-600 hover:underline"
                  >
                    {l.name}
                  </Link>
                  <span className="ml-2 text-xs text-zinc-400">
                    {[l.location_region, l.location_country]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <TypeBadge type={l.type} />
                  {enrich[l.id] ? (
                    <EnrichPill state={enrich[l.id]} />
                  ) : (
                    <ContactStatusBadge status={l.contact_status} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Active rules that will apply */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-700">
            Active rules applied to this run
          </h3>
          <Link
            href="/admin/settings/tailoring"
            className="text-sm text-blue-600 hover:underline"
          >
            Edit rules
          </Link>
        </div>
        {activeRules.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-400">
            No active tailoring rules.{" "}
            <Link href="/admin/settings/tailoring" className="text-blue-600 hover:underline">
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

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4">
          <p className="text-sm text-rose-700">{error}</p>
        </div>
      )}

      {/* Final summary */}
      {summary && !summary.error && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-sm text-zinc-800">
            <p className="font-medium">
              Added {summary.inserted} new lead
              {summary.inserted === 1 ? "" : "s"}.
            </p>
            {autoEnrich ? (
              <p className="mt-1 text-zinc-600">
                {enriching
                  ? "Finding contacts and drafting outreach…"
                  : `${enrichTotals(enrich).drafts} draft${
                      enrichTotals(enrich).drafts === 1 ? "" : "s"
                    } ready across ${enrichTotals(enrich).withEmail} contacts with email.`}
                {summary.failedBatches > 0 &&
                  ` ${summary.failedBatches} batch(es) failed and were skipped.`}
              </p>
            ) : (
              <p className="mt-1 text-zinc-600">
                {summary.needsLookup} need a manual email lookup.
                {summary.failedBatches > 0 &&
                  ` ${summary.failedBatches} batch(es) failed and were skipped.`}
              </p>
            )}
            <Link
              href="/admin/leads?status=drafted"
              className="mt-2 inline-block text-blue-600 hover:underline"
            >
              {autoEnrich ? "Review and send →" : "View new leads →"}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function enrichTotals(states: Record<string, EnrichState>) {
  let drafts = 0;
  let withEmail = 0;
  for (const st of Object.values(states)) {
    if (st.phase === "done") {
      drafts += st.result.draftsCreated;
      withEmail += st.result.contactsWithEmail;
    }
  }
  return { drafts, withEmail };
}

function EnrichPill({ state }: { state: EnrichState }) {
  const base =
    "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium";
  if (state.phase === "waiting")
    return <span className={`${base} border-zinc-200 bg-zinc-50 text-zinc-500`}>Queued</span>;
  if (state.phase === "working")
    return (
      <span className={`${base} border-blue-200 bg-blue-50 text-blue-700`}>
        Finding contacts + drafting…
      </span>
    );
  if (state.phase === "error")
    return (
      <span className={`${base} border-rose-200 bg-rose-50 text-rose-700`} title={state.message}>
        Needs attention
      </span>
    );
  const r = state.result;
  return (
    <span className={`${base} border-emerald-200 bg-emerald-50 text-emerald-700`}>
      {r.draftsCreated} draft{r.draftsCreated === 1 ? "" : "s"} · {r.contactsWithEmail} email
      {r.contactsWithEmail === 1 ? "" : "s"}
    </span>
  );
}
