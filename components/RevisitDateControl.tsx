"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateRevisit } from "@/app/actions/leads";

/**
 * Editable "Revisit on" date + "Revisit note" for any lead. Only surfaces
 * the lead (dashboard, leads list); nothing is sent when the date arrives.
 */
export function RevisitDateControl({
  leadId,
  current,
  currentNote,
}: {
  leadId: string;
  current: string | null;
  currentNote: string | null;
}) {
  const [value, setValue] = useState(current ?? "");
  const [note, setNote] = useState(currentNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const dirty = value !== (current ?? "") || note.trim() !== (currentNote ?? "").trim();
  const overdue =
    !!current && current <= new Date().toISOString().slice(0, 10);

  function save(nextDate: string | null, nextNote: string | null) {
    setError(null);
    start(async () => {
      const res = await updateRevisit(leadId, nextDate, nextNote);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="mt-3 border-t border-zinc-100 pt-3">
      <label
        htmlFor="revisit-on"
        className="mb-1 block text-xs font-medium text-zinc-500"
      >
        Revisit on
      </label>
      <input
        id="revisit-on"
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={pending}
        className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800"
      />
      <label
        htmlFor="revisit-note"
        className="mb-1 mt-2 block text-xs font-medium text-zinc-500"
      >
        Revisit note
      </label>
      <textarea
        id="revisit-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={pending}
        rows={2}
        placeholder="e.g. Booked for 2027; reach out spring 2027 for 2028"
        className="w-full rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => save(value || null, note || null)}
          disabled={pending || !dirty}
          className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setValue("");
            setNote("");
            save(null, null);
          }}
          disabled={pending || (!current && !currentNote)}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-60"
        >
          Clear
        </button>
      </div>
      {overdue && !dirty && (
        <p className="mt-1 text-xs font-medium text-rose-700">
          Due to revisit.
        </p>
      )}
      <p className="mt-1 text-xs text-zinc-400">
        Shows on the dashboard from 14 days before. Nothing is sent automatically.
      </p>
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
