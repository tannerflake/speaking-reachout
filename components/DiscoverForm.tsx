"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TypeBadge, ContactStatusBadge } from "@/components/Badge";
import { CandidateLog } from "@/components/CandidateLog";
import { stopDiscoveryRun } from "@/app/actions/pipeline";
import { ENRICH_PARALLEL, enrichLeadViaApi } from "@/lib/enrich/client";
import type { EnrichResult } from "@/lib/enrich/pipeline";
import type { DiscoveryProgress } from "@/lib/claude/discovery";
import {
  dropLines,
  foundLine,
  reusedLine,
  stopReasonText,
  type RunCounts,
} from "@/lib/discovery/report";
import type {
  DiscoverySummary,
  InsertedLead,
} from "@/lib/discovery/persist";

type EnrichState =
  | { phase: "waiting" }
  | { phase: "working" }
  | { phase: "done"; result: EnrichResult }
  | { phase: "error"; message: string };

export function DiscoverForm({ activeRules }: { activeRules: string[] }) {
  const [count, setCount] = useState(5);
  const [focus, setFocus] = useState("");
  const [running, setRunning] = useState(false);
  const [leads, setLeads] = useState<InsertedLead[]>([]);
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null);
  const [summary, setSummary] = useState<DiscoverySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [autoEnrich, setAutoEnrich] = useState(true);
  // True when the server queue handles contacts + drafts (migration 0030
  // applied). Otherwise this page drives them itself, as a fallback.
  const [queued, setQueued] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [enrich, setEnrich] = useState<Record<string, EnrichState>>({});
  const [enriching, setEnriching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // The run currently streaming, readable from event handlers.
  const live = useRef({ queued: false, autoEnrich: true, finished: false });
  // Fallback only: leads waiting for contacts + drafts, and how many are in
  // flight. Deliberately NOT reset when a new run starts, so leads from the
  // previous run are never dropped.
  const enrichQueue = useRef<string[]>([]);
  const enrichActive = useRef(0);
  const router = useRouter();

  /** Pull leads off the fallback enrich queue until it is empty. */
  function pumpEnrich() {
    while (
      enrichActive.current < ENRICH_PARALLEL &&
      enrichQueue.current.length > 0
    ) {
      const id = enrichQueue.current.shift() as string;
      enrichActive.current += 1;
      setEnriching(true);
      setEnrich((prev) => ({ ...prev, [id]: { phase: "working" } }));
      enrichLeadViaApi(id)
        .then((result) => {
          setEnrich((prev) => ({
            ...prev,
            [id]: result.error
              ? { phase: "error", message: result.error }
              : { phase: "done", result },
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
    // Keep showing leads from an earlier run that are still being prepared.
    setLeads((prev) =>
      prev.filter((l) => {
        const st = enrich[l.id];
        return st?.phase === "waiting" || st?.phase === "working";
      }),
    );
    setProgress(null);
    setSummary(null);
    setError(null);
    setNotice(null);
    setRunId(null);
    setQueued(false);
    setStopping(false);
    live.current = { queued: false, autoEnrich, finished: false };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count, focus, autoEnrich }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Discovery request failed (${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read NDJSON: one JSON event per line, flushed as things happen.
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

      if (!live.current.finished) {
        setNotice(
          "The live connection ended before the run reported back. The run keeps going on the server; its result appears under Recent runs.",
        );
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setNotice("Stopped watching this run.");
      } else {
        // The job runs server-side regardless of this connection.
        setNotice(
          `Lost the live connection (${
            e instanceof Error ? e.message : "network error"
          }). If the run had started, it keeps going on the server and appears under Recent runs.`,
        );
      }
    } finally {
      setRunning(false);
      setStopping(false);
      abortRef.current = null;
      router.refresh();
    }
  }

  function handleEvent(line: string) {
    let evt: {
      type: "run" | "lead" | "progress" | "done" | "error";
      runId?: string | null;
      queued?: boolean;
      lead?: InsertedLead;
      progress?: DiscoveryProgress;
      summary?: DiscoverySummary;
      error?: string;
    };
    try {
      evt = JSON.parse(line);
    } catch {
      return; // ignore a malformed line rather than blowing up the run
    }
    if (evt.type === "run") {
      setRunId(evt.runId ?? null);
      setQueued(Boolean(evt.queued));
      live.current.queued = Boolean(evt.queued);
      // Brings the new run into "Recent runs", which then keeps itself live.
      router.refresh();
    } else if (evt.type === "lead" && evt.lead) {
      setLeads((prev) => [...prev, evt.lead as InsertedLead]);
      // Fallback path: find contacts + draft from this page the moment the
      // lead lands. With the server queue the server has already started.
      if (live.current.autoEnrich && !live.current.queued) scheduleEnrich(evt.lead.id);
    } else if (evt.type === "progress" && evt.progress) {
      setProgress(evt.progress);
    } else if (evt.type === "done" && evt.summary) {
      live.current.finished = true;
      setSummary(evt.summary);
    } else if (evt.type === "error") {
      live.current.finished = true;
      setError(evt.error ?? "Discovery failed.");
    }
  }

  async function stop() {
    // A recorded run is stopped on the server (it finishes the searches in
    // flight and reports back). An unrecorded one can only be un-watched.
    if (runId) {
      setStopping(true);
      const res = await stopDiscoveryRun(runId);
      if (res.error) {
        setStopping(false);
        setError(`Could not stop the run: ${res.error}`);
      }
    } else {
      abortRef.current?.abort();
    }
  }

  const counts: RunCounts | null = summary
    ? {
        requested: summary.requested,
        added: summary.inserted,
        rawCount: summary.rawCount,
        duplicates: summary.duplicates,
        repeats: summary.repeats,
        ruleFiltered: summary.ruleFiltered,
        surplus: summary.surplus,
        reused: summary.reused,
        reuseDropped: summary.reuseDropped,
        backlogSaved: summary.backlogSaved,
        saveFailed: summary.saveFailed,
        failedBatches: summary.failedBatches,
        rounds: summary.rounds,
        searches: summary.searches,
      }
    : null;
  // The run that just streamed, for the list below. Leads carried over from
  // an earlier run stay listed until their contacts + drafts finish.
  const showLiveList = leads.length > 0 && !queued;

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
        <p className="mt-2 text-xs text-zinc-400">
          Discover keeps searching different sectors and regions until it has
          the number of new leads you asked for, or about four minutes pass.
          It runs on the server, so you can leave this page; progress shows
          under Recent runs.
        </p>

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
                disabled={stopping}
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-60"
              >
                {stopping ? "Stopping…" : "Stop"}
              </button>
              <span className="text-sm text-zinc-500">
                {progress
                  ? `Round ${progress.rounds}: ${progress.added} of ${count} added. ${progress.rawCount} candidates so far, ${progress.duplicates + progress.repeats} duplicates, ${progress.ruleFiltered} removed by rules.`
                  : `Researching real venues: 0 of ${count} added so far…`}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Live results — leads appear here as they're generated */}
      {showLiveList && (
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

      {notice && !error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">{notice}</p>
        </div>
      )}

      {/* Final summary: what was asked, what happened to every candidate */}
      {summary && counts && (
        <div
          className={`rounded-lg border p-4 ${
            summary.inserted >= summary.requested
              ? "border-emerald-200 bg-emerald-50"
              : "border-amber-200 bg-amber-50"
          }`}
        >
          <div className="space-y-1 text-sm text-zinc-800">
            <p className="font-medium">
              Requested {summary.requested}, added {summary.inserted} new lead
              {summary.inserted === 1 ? "" : "s"}.
            </p>
            <p className="text-zinc-700">
              {stopReasonText(summary.stopReason, summary.requested, summary.inserted)}
            </p>
            {reusedLine(counts) && <p className="text-zinc-700">{reusedLine(counts)}</p>}
            <p className="text-zinc-600">{foundLine(counts)}</p>
            {dropLines(counts).length > 0 && (
              <ul className="list-disc pl-5 text-zinc-600">
                {dropLines(counts).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {summary.errors.length > 0 && (
              <p className="text-rose-700">Search errors: {summary.errors.join("; ")}.</p>
            )}
            {(summary.warnings ?? []).map((w) => (
              <p key={w} className="text-rose-700">
                {w}
              </p>
            ))}
            {!summary.runId && (
              <p className="text-zinc-600">
                This run was not saved to Recent runs (database migration 0030
                is not applied yet).
              </p>
            )}
            {summary.inserted > 0 &&
              (!autoEnrich ? (
                <p className="text-zinc-600">
                  {summary.needsLookup} need a manual email lookup.
                </p>
              ) : queued ? (
                <p className="text-zinc-600">
                  Contacts and drafts are being prepared on the server; watch
                  them finish under Recent runs. You can leave this page.
                </p>
              ) : (
                <p className="text-zinc-600">
                  {enriching
                    ? "Finding contacts and drafting outreach. Keep this page open until it finishes."
                    : `${enrichTotals(enrich).drafts} draft${
                        enrichTotals(enrich).drafts === 1 ? "" : "s"
                      } ready across ${enrichTotals(enrich).withEmail} contacts with email.`}
                </p>
              ))}
            <CandidateLog candidates={summary.candidates} />
            <Link
              href="/admin/leads?status=drafted"
              className="mt-1 inline-block text-blue-600 hover:underline"
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
