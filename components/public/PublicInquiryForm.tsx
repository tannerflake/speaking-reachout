"use client";

import { useEffect, useState, useTransition } from "react";
import { submitInquiry } from "@/app/actions/inquiry";

const INQUIRY_TYPES = [
  { value: "press", label: "Press / media" },
  { value: "interview_student", label: "Interview or student request" },
  { value: "other", label: "Other" },
];

const field =
  "mt-1 w-full border border-rule bg-panel px-4 py-3 text-sm text-graphite placeholder-slate/60 focus:border-oxford focus:outline-none focus:ring-1 focus:ring-oxford";
const label = "block text-sm font-medium text-graphite";

/**
 * Secondary call to action for non-booking inquiries (press, interviews,
 * students, anything else). Outlined button that reveals the form in place;
 * opens on its own when the page is reached via /#inquiries (footer link).
 */
export function PublicInquiryForm({ fallbackEmail }: { fallbackEmail: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const check = () => {
      if (window.location.hash === "#inquiries") setOpen(true);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await submitInquiry({
        name: String(fd.get("name") ?? ""),
        email: String(fd.get("email") ?? ""),
        phone: String(fd.get("phone") ?? ""),
        inquiry_type: String(fd.get("inquiry_type") ?? "press"),
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
      <div className="border border-brass/40 bg-brass/[0.07] p-8 text-center">
        <h3 className="font-display text-2xl font-medium text-oxford">
          Thanks. We&rsquo;ll be in touch shortly.
        </h3>
        <p className="mt-2 text-graphite/75">
          Your inquiry is on its way to the team.
        </p>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-oxford px-6 py-3 text-sm font-semibold tracking-wide text-oxford transition-colors hover:bg-oxford/5"
        aria-expanded={false}
        aria-controls="inquiry-form"
      >
        Send a press or other inquiry
      </button>
    );
  }

  return (
    <form id="inquiry-form" onSubmit={onSubmit} className="space-y-5 text-left">
      {/* Honeypot: visually hidden, ignored by humans. */}
      <div className="absolute left-[-9999px]" aria-hidden>
        <label>
          Company URL
          <input name="company_url" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="iq-name">
            Name <span className="text-brass">*</span>
          </label>
          <input id="iq-name" name="name" required className={field} />
        </div>
        <div>
          <label className={label} htmlFor="iq-email">
            Email <span className="text-brass">*</span>
          </label>
          <input
            id="iq-email"
            name="email"
            type="email"
            required
            className={field}
          />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="iq-phone">
            Phone
          </label>
          <input id="iq-phone" name="phone" type="tel" className={field} />
        </div>
        <div>
          <label className={label} htmlFor="iq-type">
            Inquiry type
          </label>
          <select
            id="iq-type"
            name="inquiry_type"
            defaultValue="press"
            className={field}
          >
            {INQUIRY_TYPES.map((t) => (
              <option key={t.value} value={t.value} className="bg-panel text-graphite">
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={label} htmlFor="iq-msg">
          Message <span className="text-brass">*</span>
        </label>
        <textarea id="iq-msg" name="message" rows={4} required className={field} />
      </div>

      {error && <p className="text-sm text-rose-700">{error}</p>}

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-oxford px-6 py-3 text-sm font-semibold tracking-wide text-oxford transition-colors hover:bg-oxford/5 disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send inquiry"}
        </button>
        <span className="text-sm text-slate">
          Or email{" "}
          <a
            href={`mailto:${fallbackEmail}`}
            className="text-brass underline-offset-4 hover:underline"
          >
            {fallbackEmail}
          </a>
          .
        </span>
      </div>
    </form>
  );
}
