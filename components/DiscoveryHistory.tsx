import Link from "next/link";
import {
  ContactGapBadge,
  DraftGapBadge,
  StatusBadge,
  TypeBadge,
} from "@/components/Badge";
import { CandidateLog } from "@/components/CandidateLog";
import { DiscoveryRunActions } from "@/components/DiscoveryRunActions";
import {
  dropLines,
  foundLine,
  reusedLine,
  stopReasonText,
  type RunCounts,
} from "@/lib/discovery/report";
import { formatDateTime } from "@/lib/utils";
import type { DiscoveryRun, DiscoveryRunLead } from "@/lib/data";

/**
 * Discover runs from the last 24 hours, read from the database so they
 * survive leaving or refreshing the page. For each run: requested vs added,
 * where the other candidates went, why it stopped, and the contact/draft
 * state of every lead it produced.
 */
export function DiscoveryHistory({
  runs,
  available,
}: {
  runs: DiscoveryRun[];
  /** False until migration 0030 is applied (runs are not recorded). */
  available: boolean;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-medium text-zinc-700">
        Recent runs (last 24 hours)
      </h3>
      {!available ? (
        <p className="mt-1 text-sm text-amber-700">
          Runs are not being recorded yet: the database is missing the run
          tracking tables. Apply{" "}
          <code className="text-xs">supabase/migrations/0030_discovery_tracking.sql</code>{" "}
          in the Supabase SQL editor. Until then Discover still works, but
          contacts and drafts only run while this page stays open.
        </p>
      ) : runs.length === 0 ? (
        <p className="mt-1 text-sm text-zinc-400">No runs in the last 24 hours.</p>
      ) : (
        <div className="mt-2 divide-y divide-zinc-100">
          {runs.map((run, i) => (
            <RunRow key={run.id} run={run} defaultOpen={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({ run, defaultOpen }: { run: DiscoveryRun; defaultOpen: boolean }) {
  const short = run.status !== "running" && run.inserted < run.requested;
  const inQueue = run.leads.filter(
    (l) => l.enrichStatus === "pending" || l.enrichStatus === "working",
  ).length;
  // Leads the Retry button would pick up: not in the queue right now, and
  // either never searched, failed, or left with an undrafted contact.
  const retryable = run.leads.filter(
    (l) =>
      l.enrichStatus !== "pending" &&
      l.enrichStatus !== "working" &&
      (l.enrichStatus === "error" ||
        l.draftedContacts < l.emailableContacts ||
        (l.enrichStatus === null && l.emailableContacts === 0)),
  ).length;
  const noEmail = run.leads.filter(
    (l) => l.emailableContacts === 0 && l.enrichStatus === "done",
  ).length;

  return (
    <details open={defaultOpen} className="group py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm font-medium text-zinc-800">
            Requested {run.requested}, added {run.inserted}
          </span>
          <span className="ml-2 text-xs text-zinc-400">
            {formatDateTime(run.created_at)}
            {run.focus && ` · "${run.focus}"`}
          </span>
        </div>
        <RunStatusPill run={run} short={short} />
      </summary>

      <div className="mt-2 space-y-2 pl-1">
        <RunNote run={run} />
        {(inQueue > 0 || noEmail > 0) && (
          <p className="text-xs text-zinc-500">
            {[
              inQueue > 0 &&
                `Finding contacts and drafting for ${inQueue} lead${
                  inQueue === 1 ? "" : "s"
                } on the server (safe to leave this page)`,
              noEmail > 0 && `${noEmail} without a usable email`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        <DiscoveryRunActions
          runId={run.id}
          running={run.status === "running"}
          stopRequested={run.cancel_requested}
          retryable={retryable}
        />
        {run.leads.length > 0 && (
          <ul className="divide-y divide-zinc-50">
            {run.leads.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <Link
                    href={`/admin/leads/${l.id}`}
                    className="text-sm font-medium text-blue-600 hover:underline"
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
                  <EnrichPill lead={l} />
                  {l.enrichStatus !== "pending" && l.enrichStatus !== "working" && (
                    <>
                      <ContactGapBadge
                        contactsCount={l.contactsCount}
                        hasContactEmail={l.emailableContacts > 0}
                      />
                      <DraftGapBadge
                        emailableContacts={l.emailableContacts}
                        draftedContacts={l.draftedContacts}
                        hasUnsentDraft={l.hasUnsentDraft}
                      />
                    </>
                  )}
                  <StatusBadge status={l.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <CandidateLog candidates={run.candidates} />
      </div>
    </details>
  );
}

const PILL =
  "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium";

/** Where a lead is in the server-side contacts + drafts queue. */
function EnrichPill({ lead }: { lead: DiscoveryRunLead }) {
  if (lead.enrichStatus === "pending")
    return <span className={`${PILL} border-zinc-200 bg-zinc-50 text-zinc-500`}>Queued</span>;
  if (lead.enrichStatus === "working")
    return (
      <span className={`${PILL} border-blue-200 bg-blue-50 text-blue-700`}>
        Finding contacts + drafting…
      </span>
    );
  if (lead.enrichStatus === "error")
    return (
      <span
        className={`${PILL} border-rose-200 bg-rose-50 text-rose-700`}
        title={lead.enrichError ?? undefined}
      >
        Needs attention
      </span>
    );
  return null;
}

function RunNote({ run }: { run: DiscoveryRun }) {
  const counts: RunCounts = {
    requested: run.requested,
    added: run.inserted,
    rawCount: run.raw_count,
    duplicates: run.duplicates,
    repeats: run.repeats,
    ruleFiltered: run.rule_filtered,
    surplus: run.surplus,
    reused: run.reused ?? null,
    failedBatches: run.failed_batches,
    rounds: run.rounds,
    searches: run.searches,
  };
  const lines: string[] = [];
  if (run.status === "running")
    lines.push(
      run.cancel_requested
        ? "Stopping after the searches in flight."
        : "Still searching on the server. This page updates by itself; it is safe to leave.",
    );
  if (run.status === "interrupted")
    lines.push(
      "Cut off before it could record its outcome (the server's 5 minute limit). Leads added before that are listed below.",
    );
  if (run.status === "error") lines.push(`Failed: ${run.error ?? "unknown error"}.`);
  if (run.status === "done")
    lines.push(stopReasonText(run.stop_reason, run.requested, run.inserted));
  const reused = reusedLine(counts);
  if (reused) lines.push(reused);
  if (run.raw_count !== null) lines.push(foundLine(counts));
  const drops = dropLines(counts);
  if (drops.length > 0) lines.push(`Not added: ${drops.join("; ")}.`);
  if (run.status === "done" && run.error) lines.push(`Errors: ${run.error}.`);
  const text = lines.filter(Boolean);
  if (text.length === 0) return null;
  return (
    <div className="space-y-0.5 text-xs text-zinc-500">
      {text.map((t, i) => (
        <p key={i}>{t}</p>
      ))}
    </div>
  );
}

function RunStatusPill({ run, short }: { run: DiscoveryRun; short: boolean }) {
  const base =
    "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium";
  if (run.status === "running")
    return <span className={`${base} border-blue-200 bg-blue-50 text-blue-700`}>Running</span>;
  if (run.status === "interrupted")
    return <span className={`${base} border-amber-200 bg-amber-50 text-amber-700`}>Interrupted</span>;
  if (run.status === "error")
    return <span className={`${base} border-rose-200 bg-rose-50 text-rose-700`}>Failed</span>;
  if (short)
    return <span className={`${base} border-amber-200 bg-amber-50 text-amber-700`}>Short</span>;
  return <span className={`${base} border-emerald-200 bg-emerald-50 text-emerald-700`}>Complete</span>;
}
