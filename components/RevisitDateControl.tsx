"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateRevisitOn } from "@/app/actions/leads";

/** Editable "Revisit on" date for a Back burner lead. */
export function RevisitDateControl({
  leadId,
  current,
}: {
  leadId: string;
  current: string | null;
}) {
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const dirty = value !== (current ?? "");
  const overdue =
    !!current && current <= new Date().toISOString().slice(0, 10);

  function save(next: string | null) {
    setError(null);
    start(async () => {
      const res = await updateRevisitOn(leadId, next);
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
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="revisit-on"
          type="date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={pending}
          className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-800"
        />
        {dirty && (
          <button
            onClick={() => save(value || null)}
            disabled={pending}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        )}
        {!dirty && current && (
          <button
            onClick={() => {
              setValue("");
              save(null);
            }}
            disabled={pending}
            className="text-xs text-zinc-500 hover:text-zinc-700 hover:underline"
          >
            Clear
          </button>
        )}
      </div>
      {overdue && !dirty && (
        <p className="mt-1 text-xs font-medium text-sky-700">
          Due to revisit.
        </p>
      )}
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
