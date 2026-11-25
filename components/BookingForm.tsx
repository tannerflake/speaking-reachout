"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveBooking, updateBooking } from "@/app/actions/leads";
import { BOOKING_OUTCOMES, type Booking, type BookingOutcome } from "@/lib/types";
import { OUTCOME_LABEL } from "@/lib/engagements";

/**
 * Add or edit one engagement (booking). event_year is required when the
 * date is unknown; outcome left on "Auto" lets the DB derive
 * upcoming/completed from the date or year.
 */
export function BookingForm({
  leadId,
  booking,
  offerMarkBooked = true,
  onDone,
}: {
  leadId: string;
  /** Present = edit this booking. */
  booking?: Booking;
  /** Show the "Mark lead as Booked" checkbox (add mode only). */
  offerMarkBooked?: boolean;
  onDone?: () => void;
}) {
  const [eventName, setEventName] = useState(booking?.event_name ?? "");
  const [eventDate, setEventDate] = useState(booking?.event_date ?? "");
  const [endDate, setEndDate] = useState(booking?.event_end_date ?? "");
  const [year, setYear] = useState(booking?.event_year ? String(booking.event_year) : "");
  const [topic, setTopic] = useState(booking?.topic ?? "");
  const [location, setLocation] = useState(booking?.location ?? "");
  const [fee, setFee] = useState(booking?.fee != null ? String(booking.fee) : "");
  const [outcome, setOutcome] = useState<BookingOutcome | "">(booking?.outcome ?? "");
  const [recurring, setRecurring] = useState(booking?.is_recurring ?? false);
  const [notes, setNotes] = useState(booking?.notes ?? "");
  const [markBooked, setMarkBooked] = useState(offerMarkBooked);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const needsYear = !eventDate && !year.trim();

  function submit() {
    setError(null);
    start(async () => {
      const input = {
        event_name: eventName,
        event_date: eventDate || null,
        event_end_date: endDate || null,
        event_year: eventDate ? Number(eventDate.slice(0, 4)) : year ? Number(year) : null,
        topic: topic || null,
        location: location || null,
        fee: fee ? Number(fee) : null,
        outcome: outcome || null,
        is_recurring: recurring,
        notes: notes || null,
        markBooked: booking ? false : offerMarkBooked && markBooked,
      };
      const res = booking ? await updateBooking(booking.id, input) : await saveBooking(leadId, input);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (!booking) {
        setEventName("");
        setEventDate("");
        setEndDate("");
        setYear("");
        setTopic("");
        setLocation("");
        setFee("");
        setOutcome("");
        setRecurring(false);
        setNotes("");
      }
      onDone?.();
      router.refresh();
    });
  }

  const inputClass =
    "mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelClass = "block text-xs font-medium text-zinc-600";

  return (
    <div className="space-y-2">
      <div>
        <label className={labelClass}>Event name</label>
        <input value={eventName} onChange={(e) => setEventName(e.target.value)} className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>Date</label>
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>End date</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Year{eventDate ? " (from date)" : " (required if no date)"}</label>
          <input
            type="number"
            min={1990}
            max={2100}
            value={eventDate ? eventDate.slice(0, 4) : year}
            disabled={Boolean(eventDate)}
            onChange={(e) => setYear(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Outcome</label>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as BookingOutcome | "")} className={inputClass}>
            <option value="">Auto (from date)</option>
            {BOOKING_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Fee (USD)</label>
          <input type="number" min={0} value={fee} onChange={(e) => setFee(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Topic</label>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} className={inputClass} />
        </div>
      </div>
      <div>
        <label className={labelClass}>Location</label>
        <input value={location} onChange={(e) => setLocation(e.target.value)} className={inputClass} />
      </div>
      <div>
        <label className={labelClass}>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-700">
        <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
        Recurring event (offer to reach out again next cycle)
      </label>
      {!booking && offerMarkBooked && (
        <label className="flex items-center gap-2 text-xs text-zinc-700">
          <input type="checkbox" checked={markBooked} onChange={(e) => setMarkBooked(e.target.checked)} />
          Also set the lead&apos;s status to Booked
        </label>
      )}
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={pending || !eventName.trim() || needsYear}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : booking ? "Save changes" : "Add engagement"}
        </button>
        {onDone && (
          <button type="button" onClick={onDone} className="text-sm text-zinc-500 hover:underline">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
