"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { findMultipleContacts } from "@/app/actions/contacts";

/**
 * Multi-source contact search for one lead: every configured web-search LLM
 * plus one Hunter domain search. Operator-triggered only.
 */
export function FindContactsButton({
  leadId,
  sources,
  max,
  hunterAvailable,
}: {
  leadId: string;
  sources: string[];
  max: number;
  hunterAvailable: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function run() {
    const cost = hunterAvailable
      ? " Uses one AI search per source and at most one Hunter credit."
      : " Uses one AI search per source.";
    if (!window.confirm(`Search for up to ${max} contacts at this org?${cost}`)) return;
    setMessage(null);
    setError(null);
    start(async () => {
      const res = await findMultipleContacts(leadId);
      const skipped = res.failed.length
        ? ` Skipped: ${res.failed.map((f) => `${f.source} (${f.reason})`).join("; ")}.`
        : "";
      if (res.error) {
        setError(`${res.error}${skipped}`);
      } else {
        setMessage(
          `Added ${res.added} contacts, ${res.withEmail} with email, from ${[
            ...res.sources,
            ...(res.hunterUsed ? ["hunter"] : []),
          ].join(", ")}.${skipped}`,
        );
      }
      router.refresh();
    });
  }

  return (
    <div className="mb-3">
      <button
        onClick={run}
        disabled={pending || sources.length === 0}
        className="rounded-md border border-blue-600 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60"
      >
        {pending ? "Searching…" : `Find up to ${max} contacts`}
      </button>
      <span className="ml-2 text-xs text-zinc-500">
        {sources.join(" + ")}
        {hunterAvailable ? " + Hunter" : ""}
      </span>
      {pending && (
        <p className="mt-2 text-sm text-zinc-500">
          Asking each AI to search the web for center directors, program staff,
          and lecture series organizers, then checking each person against the
          page it cites. This can take 2 to 3 minutes.
        </p>
      )}
      {message && (
        <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
