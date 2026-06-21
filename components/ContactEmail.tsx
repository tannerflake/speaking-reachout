"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resolveContactEmail, setContactEmail } from "@/app/actions/contacts";

export function ContactEmail({
  contactId,
  canResolve,
  providerName,
  website,
}: {
  contactId: string;
  /** A paid provider is configured AND the lead has a domain to search. */
  canResolve: boolean;
  providerName: string;
  website: string | null;
}) {
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function find() {
    setError(null);
    start(async () => {
      const res = await resolveContactEmail(contactId);
      if (res.error) setError(res.error);
      router.refresh();
    });
  }

  function save() {
    setError(null);
    start(async () => {
      const res = await setContactEmail(contactId, manual);
      if (res.error) {
        setError(res.error);
        return;
      }
      setManual("");
      router.refresh();
    });
  }

  return (
    <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
      <p className="font-medium">No email yet — resolve it before sending.</p>

      {canResolve && (
        <button
          onClick={find}
          disabled={pending}
          className="mt-2 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? "Searching…" : `Find email via ${providerName}`}
        </button>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="email"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="or paste an email"
          className="min-w-0 flex-1 rounded border border-amber-300 bg-white px-2 py-1 text-xs text-zinc-800 focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={save}
          disabled={pending || !manual.trim()}
          className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
        >
          Save
        </button>
      </div>

      {website && (
        <p className="mt-1.5">
          Or find it on{" "}
          <a
            href={website}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline"
          >
            {website}
          </a>
          .
        </p>
      )}
      {error && <p className="mt-1.5 text-rose-700">{error}</p>}
    </div>
  );
}
