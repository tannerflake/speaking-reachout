import Link from "next/link";
import {
  ContactGapBadge,
  DraftGapBadge,
  StatusBadge,
  TypeBadge,
} from "@/components/Badge";
import { formatDateTime } from "@/lib/utils";
import type { DiscoveryRun } from "@/lib/data";

/**
 * Discover runs from the last 24 hours, read from the database so they
 * survive leaving or refreshing the page. Shows found vs requested per run
 * and the contact/draft coverage of each lead it produced.
 */
export function DiscoveryHistory({ runs }: { runs: DiscoveryRun[] }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-medium text-zinc-700">
        Recent runs (last 24 hours)
      </h3>
      {runs.length === 0 ? (
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
  const needsDrafts = run.leads.filter(
    (l) => l.emailableContacts > 0 && l.draftedContacts < l.emailableContacts,
  ).length;
  const noEmail = run.leads.filter((l) => l.emailableContacts === 0).length;

  return (
    <details open={defaultOpen} className="group py-2">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-sm font-medium text-zinc-800">
            {run.inserted} of {run.requested} found
          </span>
          <span className="ml-2 text-xs text-zinc-400">
            {formatDateTime(run.created_at)}
            {run.focus && ` · "${run.focus}"`}
          </span>
        </div>
        <RunStatusPill run={run} short={short} />
      </summary>

      <div className="mt-2 space-y-2 pl-1">
        <RunNote run={run} short={short} />
        {(needsDrafts > 0 || noEmail > 0) && (
          <p className="text-xs text-zinc-500">
            {[
              needsDrafts > 0 &&
                `${needsDrafts} lead${needsDrafts === 1 ? "" : "s"} missing drafts`,
              noEmail > 0 &&
                `${noEmail} without a usable email`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
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
                  <ContactGapBadge
                    contactsCount={l.contactsCount}
                    hasContactEmail={l.emailableContacts > 0}
                  />
                  <DraftGapBadge
                    emailableContacts={l.emailableContacts}
                    draftedContacts={l.draftedContacts}
                    hasUnsentDraft={l.hasUnsentDraft}
                  />
                  <StatusBadge status={l.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function RunNote({ run, short }: { run: DiscoveryRun; short: boolean }) {
  const parts: string[] = [];
  if (run.status === "running") parts.push("Still running. Refresh to see new leads.");
  if (run.status === "interrupted")
    parts.push("Cut off before finishing (likely the 5 minute server limit).");
  if (run.status === "error") parts.push(`Failed: ${run.error ?? "unknown error"}.`);
  if (run.status === "done" && short) {
    const raw = run.raw_count ?? 0;
    parts.push(
      `Came up ${run.requested - run.inserted} short. The models proposed ${raw} candidate${
        raw === 1 ? "" : "s"
      }; the rest were duplicates of existing leads or filtered out by the rules.`,
    );
  }
  if (run.failed_batches)
    parts.push(
      `${run.failed_batches} search batch${run.failed_batches === 1 ? "" : "es"} failed.`,
    );
  if (parts.length === 0) return null;
  return <p className="text-xs text-zinc-500">{parts.join(" ")}</p>;
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
