"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateLeadStatus } from "@/app/actions/leads";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/types";
import { cn, statusClasses, statusLabel } from "@/lib/utils";

/**
 * Statuses that first show the optional revisit prompt (date + note).
 * Add a status here to give it the same prompt.
 */
const REVISIT_PROMPT_STATUSES: LeadStatus[] = ["interested", "back_burner"];

export function StatusControl({
  leadId,
  current,
  currentRevisitOn = null,
  currentRevisitNote = null,
}: {
  leadId: string;
  current: LeadStatus;
  currentRevisitOn?: string | null;
  currentRevisitNote?: string | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Moving to a REVISIT_PROMPT_STATUSES status first asks (optionally) for a
  // revisit date + note, pre-filled with the lead's existing ones.
  const [askRevisitFor, setAskRevisitFor] = useState<LeadStatus | null>(null);
  const [revisitOn, setRevisitOn] = useState(currentRevisitOn ?? "");
  const [revisitNote, setRevisitNote] = useState(currentRevisitNote ?? "");
  const router = useRouter();

  function set(s: LeadStatus, revisit?: { on: string | null; note: string | null }) {
    setError(null);
    start(async () => {
      const res = await updateLeadStatus(leadId, s, revisit);
      if (res?.error) setError(res.error);
      setAskRevisitFor(null);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {LEAD_STATUSES.map((s) => (
          <button
            key={s}
            disabled={pending || s === current}
            onClick={() => {
              if (REVISIT_PROMPT_STATUSES.includes(s)) {
                setRevisitOn(currentRevisitOn ?? "");
                setRevisitNote(currentRevisitNote ?? "");
                setAskRevisitFor(s);
              } else {
                set(s);
              }
            }}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              s === current
                ? `${statusClasses(s)} ring-2 ring-zinc-300 ring-offset-1`
                : "border-zinc-200 text-zinc-500 hover:bg-zinc-50",
              pending && "opacity-60",
            )}
          >
            {statusLabel(s)}
          </button>
        ))}
      </div>
      {askRevisitFor && (
        <div
          role="group"
          aria-label={`Move to ${statusLabel(askRevisitFor)}`}
          className="mt-3 space-y-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm"
        >
          <p className="text-xs text-sky-900">
            Moving to {statusLabel(askRevisitFor)}. Optional: when should someone pick this back
            up? Leave both blank to skip.
          </p>
          <div>
            <label
              htmlFor="bb-revisit-on"
              className="mb-1 block text-xs font-medium text-zinc-600"
            >
              Revisit on
            </label>
            <input
              id="bb-revisit-on"
              type="date"
              value={revisitOn}
              onChange={(e) => setRevisitOn(e.target.value)}
              disabled={pending}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-800"
            />
          </div>
          <div>
            <label
              htmlFor="bb-revisit-note"
              className="mb-1 block text-xs font-medium text-zinc-600"
            >
              Revisit note
            </label>
            <textarea
              id="bb-revisit-note"
              value={revisitNote}
              onChange={(e) => setRevisitNote(e.target.value)}
              disabled={pending}
              rows={2}
              className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-800"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                const on = revisitOn || null;
                const note = revisitNote.trim() || null;
                // Unchanged pre-filled values: just move, no duplicate log entry.
                const unchanged =
                  on === (currentRevisitOn ?? null) &&
                  note === (currentRevisitNote?.trim() || null);
                set(askRevisitFor, unchanged ? undefined : { on, note });
              }}
              disabled={pending}
              className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-60"
            >
              {pending ? "Saving…" : `Move to ${statusLabel(askRevisitFor)}`}
            </button>
            <button
              type="button"
              onClick={() => set(askRevisitFor)}
              disabled={pending}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-60"
            >
              Skip, move without a date
            </button>
            <button
              type="button"
              onClick={() => setAskRevisitFor(null)}
              disabled={pending}
              className="px-1 text-xs text-zinc-500 hover:text-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
