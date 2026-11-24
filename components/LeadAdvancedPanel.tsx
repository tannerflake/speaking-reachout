"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  clearAttributionOverride,
  mergeLeadInto,
  previewMerge,
  searchMergeTargets,
  setAttributionOverride,
  type MergePreview,
  type MergeTargetOption,
} from "@/app/actions/attribution";
import { OriginBadge } from "@/components/Badge";
import { originValueLabel, type EffectiveOrigin } from "@/lib/attribution";
import type { AttributionOverride } from "@/lib/types";
import { formatDateTime, statusLabel } from "@/lib/utils";

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const labelClass = "mb-1 block text-xs font-medium text-zinc-500";

function OriginLine({ origin }: { origin: EffectiveOrigin }) {
  return origin.via ? (
    <OriginBadge via={origin.via} overridden={origin.overridden} reason={origin.reason} />
  ) : (
    <span className="text-xs text-zinc-500">Nothing sent yet</span>
  );
}

// ---- Merge -------------------------------------------------------------------

function MergeSection({ leadId, leadName }: { leadId: string; leadName: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MergeTargetOption[] | null>(null);
  const [target, setTarget] = useState<MergeTargetOption | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function search() {
    setError(null);
    start(async () => {
      const res = await searchMergeTargets(leadId, query);
      if (res.error) setError(res.error);
      setResults(res.results);
    });
  }

  function choose(t: MergeTargetOption) {
    setError(null);
    setTarget(t);
    setPreview(null);
    setConfirm("");
    start(async () => {
      const res = await previewMerge(leadId, t.id);
      if (res.error) setError(res.error);
      else setPreview(res.preview ?? null);
    });
  }

  const confirmed =
    !!target && (confirm.trim() === target.name.trim() || confirm.trim() === "MERGE");

  function merge() {
    if (!target || !confirmed) return;
    setError(null);
    start(async () => {
      const res = await mergeLeadInto(leadId, target.id, confirm);
      if (res.error) {
        setError(res.error);
        return;
      }
      setDone(res.summary ?? "Merged.");
      router.push(`/admin/leads/${target.id}`);
    });
  }

  return (
    <section aria-labelledby="merge-heading" className="space-y-3">
      <h3 id="merge-heading" className="text-sm font-semibold text-zinc-800">
        Merge into another lead
      </h3>
      <p className="text-xs text-zinc-500">
        For a duplicate record of the same organization. Moves this lead&apos;s
        contacts, outreach, activity and bookings into the lead you pick. This
        lead is kept (marked Junk, shown as merged), never deleted.
      </p>
      <div>
        <label htmlFor="merge-search" className={labelClass}>
          Search leads by organization name
        </label>
        <div className="flex gap-2">
          <input
            id="merge-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                search();
              }
            }}
            className={inputClass}
          />
          <button
            type="button"
            onClick={search}
            disabled={pending || query.trim().length < 2}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
          >
            Search
          </button>
        </div>
      </div>

      {results && (
        <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-zinc-500">No matching leads.</li>
          ) : (
            results.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  {r.name}
                  <span className="ml-2 text-xs text-zinc-500">
                    {statusLabel(r.status)}
                    {r.location ? ` · ${r.location}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => choose(r)}
                  disabled={pending}
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium disabled:opacity-60 ${
                    target?.id === r.id
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
                  }`}
                >
                  {target?.id === r.id ? "Selected" : "Select"}
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      {preview && target && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-medium">
            Preview: merge &quot;{leadName}&quot; into &quot;{target.name}&quot;
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            <li>
              Contacts moving: {preview.contactsMoving.length}
              {preview.contactsMoving.length > 0 &&
                ` (${preview.contactsMoving
                  .map((c) => c.name || c.email || "unnamed")
                  .join(", ")})`}
            </li>
            {preview.contactsFolded.length > 0 && (
              <li>
                Same email already on target (target&apos;s contact kept, history
                repointed): {preview.contactsFolded.map((c) => c.email).join(", ")}
              </li>
            )}
            <li>
              Outreach rows: {preview.outreach.total} ({preview.outreach.sent} sent,{" "}
              {preview.outreach.appSent} sent via app)
            </li>
            <li>Interactions / notes: {preview.interactions}</li>
            <li>
              Bookings: {preview.bookings.length}
              {preview.bookings.length > 0 && ` (${preview.bookings.join(", ")})`}
            </li>
            {preview.followupSequences > 0 && (
              <li>Follow-up sequences: {preview.followupSequences}</li>
            )}
          </ul>
          <div className="grid gap-1 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-40 text-amber-900">This lead&apos;s attribution:</span>
              <OriginLine origin={preview.source.origin} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-40 text-amber-900">Target&apos;s attribution:</span>
              <OriginLine origin={preview.target.origin} />
            </div>
            <div className="flex flex-wrap items-center gap-2 font-medium">
              <span className="w-40">After merge:</span>
              <OriginLine origin={preview.result.origin} />
              <span className="font-normal text-amber-900">
                (earliest sent outreach across both leads
                {preview.result.origin.overridden ? "; override kept" : ""})
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-40 text-amber-900">Status after merge:</span>
              <span>{statusLabel(preview.result.status)}</span>
            </div>
          </div>
          <div>
            <label htmlFor="merge-confirm" className="mb-1 block text-xs font-medium text-amber-900">
              Type the target&apos;s exact name ({target.name}) or MERGE to confirm
            </label>
            <input
              id="merge-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              className={inputClass}
            />
          </div>
          <button
            type="button"
            onClick={merge}
            disabled={pending || !confirmed}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {pending ? "Merging…" : "Confirm merge"}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
      {done && <p className="text-xs text-emerald-700">{done}</p>}
    </section>
  );
}

// ---- Attribution override -------------------------------------------------------

function AttributionSection({
  leadId,
  origin,
}: {
  leadId: string;
  origin: EffectiveOrigin;
}) {
  const [value, setValue] = useState<"" | AttributionOverride>("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [clearReason, setClearReason] = useState("");
  const [clearConfirm, setClearConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const canSave = !!value && reason.trim().length >= 10 && confirm.trim() === "CONFIRM";

  function save() {
    if (!value || !canSave) return;
    setError(null);
    start(async () => {
      const res = await setAttributionOverride(leadId, value, reason, confirm);
      if (res.error) {
        setError(res.error);
        return;
      }
      setValue("");
      setReason("");
      setConfirm("");
      router.refresh();
    });
  }

  function clear() {
    setError(null);
    start(async () => {
      const res = await clearAttributionOverride(leadId, clearReason, clearConfirm);
      if (res.error) {
        setError(res.error);
        return;
      }
      setClearReason("");
      setClearConfirm("");
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="attribution-heading" className="space-y-3">
      <h3 id="attribution-heading" className="text-sm font-semibold text-zinc-800">
        Edit attribution
      </h3>
      <div className="space-y-1 text-xs text-zinc-600">
        <div className="flex flex-wrap items-center gap-2">
          <span>Current attribution:</span>
          <OriginLine origin={origin} />
        </div>
        <div>
          First sent outreach channel: {originValueLabel(origin.computed)} (outreach
          rows are never changed here).
        </div>
        {origin.overridden && (
          <div>
            Overridden by {origin.by ?? "unknown"}
            {origin.at ? ` on ${formatDateTime(origin.at)}` : ""}. Reason: {origin.reason}
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-md border border-zinc-200 p-3">
        <div>
          <label htmlFor="attr-value" className={labelClass}>
            New attribution
          </label>
          <select
            id="attr-value"
            value={value}
            onChange={(e) => setValue(e.target.value as "" | AttributionOverride)}
            className={inputClass}
          >
            <option value="">Choose…</option>
            <option value="app">Sent via app (commissionable)</option>
            <option value="not_app">Not via app</option>
          </select>
        </div>
        <div>
          <label htmlFor="attr-reason" className={labelClass}>
            Reason (required, at least 10 characters)
          </label>
          <textarea
            id="attr-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="attr-confirm" className={labelClass}>
            Type CONFIRM to confirm
          </label>
          <input
            id="attr-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            className={inputClass}
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={pending || !canSave}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save attribution override"}
        </button>
      </div>

      {origin.overridden && (
        <div className="space-y-2 rounded-md border border-zinc-200 p-3">
          <p className="text-xs font-medium text-zinc-700">Clear override</p>
          <div>
            <label htmlFor="attr-clear-reason" className={labelClass}>
              Reason for clearing (optional)
            </label>
            <input
              id="attr-clear-reason"
              value={clearReason}
              onChange={(e) => setClearReason(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="attr-clear-confirm" className={labelClass}>
              Type CONFIRM to clear the override
            </label>
            <input
              id="attr-clear-confirm"
              value={clearConfirm}
              onChange={(e) => setClearConfirm(e.target.value)}
              autoComplete="off"
              className={inputClass}
            />
          </div>
          <button
            type="button"
            onClick={clear}
            disabled={pending || clearConfirm.trim() !== "CONFIRM"}
            className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
          >
            Clear override
          </button>
        </div>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </section>
  );
}

// ---- Panel ---------------------------------------------------------------------

export function LeadAdvancedPanel({
  leadId,
  leadName,
  origin,
  merged,
  history,
}: {
  leadId: string;
  leadName: string;
  origin: EffectiveOrigin;
  /** Already merged into another lead: merge/override are not offered. */
  merged: boolean;
  history: Array<{ id: string; detail: string | null; created_at: string }>;
}) {
  return (
    <div className="space-y-6">
      {!merged && <MergeSection leadId={leadId} leadName={leadName} />}
      {!merged && <AttributionSection leadId={leadId} origin={origin} />}
      <section aria-labelledby="attr-history-heading">
        <h3 id="attr-history-heading" className="mb-2 text-sm font-semibold text-zinc-800">
          Attribution history
        </h3>
        {history.length === 0 ? (
          <p className="text-xs text-zinc-500">
            No overrides, merges or referred contacts yet. Attribution follows the
            first sent outreach.
          </p>
        ) : (
          <ul className="space-y-2">
            {history.map((h) => (
              <li key={h.id} className="text-xs">
                <span className="text-zinc-700">{h.detail}</span>
                <span className="ml-1 text-zinc-400">{formatDateTime(h.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
