"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  addReferredContact,
  type ReferredContactResult,
} from "@/app/actions/contacts";

/**
 * "Add referred contact": someone at the org said "talk to X instead". X is
 * saved on this lead (attribution unchanged) and handled by hand: never
 * cold-emailed or followed up automatically.
 */
export function AddReferredContact({
  leadId,
  contacts,
}: {
  leadId: string;
  contacts: Array<{ id: string; name: string | null; email: string | null }>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [phone, setPhone] = useState("");
  const [referredBy, setReferredBy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<ReferredContactResult["duplicate"] | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const inputClass =
    "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  function submit(allowDuplicate: boolean) {
    setError(null);
    setDone(null);
    if (!allowDuplicate) setDuplicate(null);
    start(async () => {
      const res = await addReferredContact(leadId, {
        name,
        email,
        role: role || null,
        phone: phone || null,
        referredById: referredBy,
        note: note || null,
        allowDuplicate,
      });
      if (res.duplicate) {
        setDuplicate(res.duplicate);
        return;
      }
      if (res.error) {
        setError(res.error);
        return;
      }
      setDone(`Added ${name}.`);
      setName("");
      setEmail("");
      setRole("");
      setPhone("");
      setReferredBy("");
      setNote("");
      setDuplicate(null);
      router.refresh();
    });
  }

  if (contacts.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        A referred contact needs someone on this lead who referred them; add
        that contact first.
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
      aria-label="Add referred contact"
      className="space-y-2"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="ref-name" className="mb-1 block text-xs font-medium text-zinc-500">
            Name
          </label>
          <input id="ref-name" value={name} onChange={(e) => setName(e.target.value)} required className={inputClass} />
        </div>
        <div>
          <label htmlFor="ref-email" className="mb-1 block text-xs font-medium text-zinc-500">
            Email
          </label>
          <input
            id="ref-email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setDuplicate(null);
            }}
            required
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="ref-role" className="mb-1 block text-xs font-medium text-zinc-500">
            Title / role
          </label>
          <input id="ref-role" value={role} onChange={(e) => setRole(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor="ref-phone" className="mb-1 block text-xs font-medium text-zinc-500">
            Phone (optional)
          </label>
          <input id="ref-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} />
        </div>
      </div>
      <div>
        <label htmlFor="ref-by" className="mb-1 block text-xs font-medium text-zinc-500">
          Referred by
        </label>
        <select
          id="ref-by"
          value={referredBy}
          onChange={(e) => setReferredBy(e.target.value)}
          required
          className={inputClass}
        >
          <option value="">Choose who referred them…</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || c.email || "Unnamed contact"}
              {c.name && c.email ? ` (${c.email})` : ""}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="ref-note" className="mb-1 block text-xs font-medium text-zinc-500">
          Note (optional)
        </label>
        <textarea id="ref-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={inputClass} />
      </div>

      {duplicate && (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {email} is already a contact
          {duplicate.contactName ? ` (${duplicate.contactName})` : ""} on{" "}
          <Link href={`/admin/leads/${duplicate.leadId}`} className="font-medium text-blue-700 underline">
            {duplicate.leadName}
          </Link>
          . If that is the same organization, use &quot;Merge into another
          lead&quot; (Advanced, bottom of this page) instead of creating a
          duplicate.
          <div className="mt-2">
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={pending}
              className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60"
            >
              Add anyway
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save referred contact"}
        </button>
        <span className="text-xs text-zinc-400">
          Not emailed or followed up automatically; write to them by hand.
        </span>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      {done && <p className="text-xs text-emerald-700">{done}</p>}
    </form>
  );
}
