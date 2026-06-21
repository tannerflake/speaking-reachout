"use client";

import { useState, useTransition } from "react";
import { submitBooking } from "@/app/actions/booking";

const EVENT_TYPES = [
  "University Event",
  "Keynote",
  "Corporate Retreat",
  "Panel",
  "Q&A",
  "Commencement",
  "Other",
];

const field =
  "mt-1 w-full rounded-lg border border-white/15 bg-white/[0.04] px-4 py-3 text-sm text-white placeholder-white/35 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";
const label = "block text-sm font-medium text-white/80";

export function PublicBookingForm({ fallbackEmail }: { fallbackEmail: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await submitBooking({
        name: String(fd.get("name") ?? ""),
        email: String(fd.get("email") ?? ""),
        organization: String(fd.get("organization") ?? ""),
        event_type: String(fd.get("event_type") ?? "Other"),
        timeframe: String(fd.get("timeframe") ?? ""),
        message: String(fd.get("message") ?? ""),
        company_url: String(fd.get("company_url") ?? ""),
      });
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setDone(true);
      form.reset();
    });
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-accent/30 bg-accent/[0.07] p-8 text-center">
        <h3 className="font-display text-2xl font-semibold text-white">
          Thanks. We&rsquo;ll be in touch shortly.
        </h3>
        <p className="mt-2 text-white/70">
          Your inquiry is on its way to the team.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Honeypot: visually hidden, ignored by humans. */}
      <div className="absolute left-[-9999px]" aria-hidden>
        <label>
          Company URL
          <input name="company_url" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="bf-name">
            Name <span className="text-accent-bright">*</span>
          </label>
          <input id="bf-name" name="name" required className={field} />
        </div>
        <div>
          <label className={label} htmlFor="bf-email">
            Email <span className="text-accent-bright">*</span>
          </label>
          <input
            id="bf-email"
            name="email"
            type="email"
            required
            className={field}
          />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="bf-org">
          Organization / Institution <span className="text-accent-bright">*</span>
        </label>
        <input id="bf-org" name="organization" required className={field} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="bf-type">
            Event type
          </label>
          <select
            id="bf-type"
            name="event_type"
            defaultValue="University Event"
            className={field}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t} className="bg-navy-900">
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="bf-when">
            Proposed date / timeframe
          </label>
          <input
            id="bf-when"
            name="timeframe"
            placeholder="e.g. Spring 2026"
            className={field}
          />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="bf-msg">
          Message / details
        </label>
        <textarea id="bf-msg" name="message" rows={4} className={field} />
      </div>

      {error && <p className="text-sm text-rose-300">{error}</p>}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-accent px-7 py-3.5 text-base font-semibold text-white transition-colors hover:bg-accent-bright disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send inquiry"}
        </button>
        <span className="text-sm text-white/55">
          Or email{" "}
          <a
            href={`mailto:${fallbackEmail}`}
            className="text-accent-bright underline-offset-4 hover:underline"
          >
            {fallbackEmail}
          </a>
          .
        </span>
      </div>
    </form>
  );
}
