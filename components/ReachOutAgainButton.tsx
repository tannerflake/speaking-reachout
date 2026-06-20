"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reachOutAgain } from "@/app/actions/leads";

export function ReachOutAgainButton({ leadId }: { leadId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function run() {
    setError(null);
    start(async () => {
      const res = await reachOutAgain(leadId);
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-1">
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-60"
      >
        {pending ? "Drafting…" : "Reach out again"}
      </button>
      {error && <p className="text-sm text-rose-600">{error}</p>}
    </div>
  );
}
