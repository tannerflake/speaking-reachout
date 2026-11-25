"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BookingForm } from "@/components/BookingForm";
import { InboxChip, OutcomeBadge } from "@/components/Badge";
import { deleteBooking } from "@/app/actions/leads";
import { formatFeeUsd } from "@/lib/engagements";
import { formatDate } from "@/lib/utils";
import type { Booking } from "@/lib/types";

/**
 * A lead's engagement history (bookings), newest year first, with add / edit
 * / delete. One status per lead; this list is where each year lives.
 */
export function EngagementsPanel({
  leadId,
  bookings,
  leadIsBooked,
}: {
  leadId: string;
  bookings: Booking[];
  leadIsBooked: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <div className="space-y-3">
      {bookings.length === 0 ? (
        <p className="text-sm text-zinc-500">No engagements recorded.</p>
      ) : (
        <ul className="space-y-2">
          {bookings.map((b) =>
            editing === b.id ? (
              <li key={b.id} className="rounded-md border border-blue-200 p-2">
                <BookingForm leadId={leadId} booking={b} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={b.id} className="rounded-md border border-zinc-200 p-2 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-zinc-800">
                      <span className="mr-1.5 text-zinc-500">{b.event_year ?? "Year ?"}</span>
                      {b.event_name}
                      {b.is_recurring && (
                        <span className="ml-2 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                          recurring
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {b.event_date
                        ? `${formatDate(b.event_date)}${b.event_end_date && b.event_end_date !== b.event_date ? ` to ${formatDate(b.event_end_date)}` : ""}`
                        : "date TBD"}
                      {formatFeeUsd(b.fee) ? ` · ${formatFeeUsd(b.fee)}` : ""}
                      {b.location ? ` · ${b.location}` : ""}
                      {b.topic ? ` · ${b.topic}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <OutcomeBadge outcome={b.outcome} />
                    {b.source === "bot_import" && <InboxChip inbox={b.source_inbox ? `bot: ${b.source_inbox}` : "bot"} />}
                  </div>
                </div>
                {b.notes && <div className="mt-1 whitespace-pre-wrap text-xs text-zinc-500">{b.notes}</div>}
                <div className="mt-1.5 flex items-center gap-3 text-xs">
                  <button type="button" onClick={() => setEditing(b.id)} className="text-blue-600 hover:underline">
                    Edit
                  </button>
                  {confirmDelete === b.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-zinc-600">Delete this engagement?</span>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          start(async () => {
                            const res = await deleteBooking(b.id);
                            if (res.error) setError(res.error);
                            setConfirmDelete(null);
                            router.refresh();
                          })
                        }
                        className="font-medium text-rose-600 hover:underline"
                      >
                        Delete
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(null)} className="text-zinc-500 hover:underline">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(b.id)} className="text-rose-600 hover:underline">
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600">Add an engagement</summary>
        <div className="mt-3">
          <BookingForm leadId={leadId} offerMarkBooked={!leadIsBooked} />
        </div>
      </details>
    </div>
  );
}
