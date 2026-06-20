"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateLeadStatus } from "@/app/actions/leads";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/types";
import { cn, statusClasses, statusLabel } from "@/lib/utils";

export function StatusControl({
  leadId,
  current,
}: {
  leadId: string;
  current: LeadStatus;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function set(s: LeadStatus) {
    start(async () => {
      await updateLeadStatus(leadId, s);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {LEAD_STATUSES.map((s) => (
        <button
          key={s}
          disabled={pending || s === current}
          onClick={() => set(s)}
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
  );
}
