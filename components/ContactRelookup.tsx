"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { relookupContact } from "@/app/actions/contacts";

/**
 * Shown on a contact that already has an email, so the operator can replace a
 * bad/bounced contact with a fresh one from the paid provider (Hunter/Apollo).
 * One paid lookup per click — never automatic.
 */
export function ContactRelookup({
  contactId,
  providerName,
}: {
  contactId: string;
  providerName: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function relookup() {
    if (
      !window.confirm(
        `Look up a fresh contact via ${providerName} and replace this one? This uses one paid lookup.`,
      )
    ) {
      return;
    }
    setError(null);
    start(async () => {
      const res = await relookupContact(contactId);
      if (res.error) setError(res.error);
      router.refresh();
    });
  }

  return (
    <div className="mt-1.5">
      <button
        onClick={relookup}
        disabled={pending}
        className="text-xs font-medium text-zinc-500 hover:text-blue-600 hover:underline disabled:opacity-60"
      >
        {pending
          ? "Looking up…"
          : `Email bouncing? Replace via ${providerName}`}
      </button>
      {error && <p className="mt-1 text-xs text-rose-700">{error}</p>}
    </div>
  );
}
