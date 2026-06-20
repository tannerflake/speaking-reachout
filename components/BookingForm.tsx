"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveBooking } from "@/app/actions/leads";

export function BookingForm({ leadId }: { leadId: string }) {
  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [topic, setTopic] = useState("");
  const [fee, setFee] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function submit() {
    setError(null);
    start(async () => {
      const res = await saveBooking(leadId, {
        event_name: eventName,
        event_date: eventDate || null,
        topic: topic || null,
        fee: fee ? Number(fee) : null,
        is_recurring: recurring,
        notes: notes || null,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setEventName("");
      setEventDate("");
      setTopic("");
      setFee("");
      setRecurring(false);
      setNotes("");
      router.refresh();
    });
  }

  const inputClass =
    "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-zinc-700">
            Event name
          </label>
          <input
            value={eventName}
            onChange={(e) => setEventName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700">
            Event date
          </label>
          <input
            type="date"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700">Topic</label>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700">
            Fee (optional)
          </label>
          <input
            type="number"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            className={inputClass}
          />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-zinc-700">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className={inputClass}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          checked={recurring}
          onChange={(e) => setRecurring(e.target.checked)}
        />
        Recurring event (offer to reach out again next cycle)
      </label>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <button
        onClick={submit}
        disabled={pending || !eventName.trim()}
        className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save booking"}
      </button>
    </div>
  );
}
