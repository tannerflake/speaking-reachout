"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { OutreachStatusBadge } from "@/components/Badge";
import {
  approveAndSend,
  generateDraft,
  regenerateDraft,
  updateDraft,
} from "@/app/actions/outreach";
import type { Contact, Outreach } from "@/lib/types";
import { formatDateTime, looksLikeRealEmail, pickPrimaryContact } from "@/lib/utils";

interface Buf {
  subject: string;
  body: string;
}

export function OutreachManager({
  leadId,
  contacts,
  outreach,
}: {
  leadId: string;
  contacts: Contact[];
  outreach: Outreach[];
}) {
  const primary = pickPrimaryContact(contacts);
  const [contactId, setContactId] = useState<string>(primary?.id ?? "");
  const [newOneOff, setNewOneOff] = useState("");
  const [bufs, setBufs] = useState<Record<string, Buf>>({});
  const [oneOffs, setOneOffs] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function clearMsgs() {
    setMessage(null);
    setError(null);
  }

  function getBuf(item: Outreach): Buf {
    return bufs[item.id] ?? { subject: item.subject, body: item.body };
  }
  function setBuf(id: string, patch: Partial<Buf>, item: Outreach) {
    setBufs((prev) => ({
      ...prev,
      [id]: { ...getBufFor(prev, item), ...patch },
    }));
  }
  function getBufFor(map: Record<string, Buf>, item: Outreach): Buf {
    return map[item.id] ?? { subject: item.subject, body: item.body };
  }
  function clearBuf(id: string) {
    setBufs((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function draftNew() {
    clearMsgs();
    setBusyId("new");
    start(async () => {
      const res = await generateDraft(
        leadId,
        contactId || null,
        newOneOff.trim() || undefined,
      );
      setBusyId(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      setNewOneOff("");
      if (res.styleAdjusted)
        setMessage("Draft created. Style rules were applied automatically.");
      else setMessage("Draft created.");
      router.refresh();
    });
  }

  function save(item: Outreach) {
    clearMsgs();
    const buf = getBuf(item);
    setBusyId(item.id);
    start(async () => {
      const res = await updateDraft(item.id, buf.subject, buf.body);
      setBusyId(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      clearBuf(item.id);
      setMessage("Draft saved.");
      router.refresh();
    });
  }

  function regenerate(item: Outreach) {
    clearMsgs();
    setBusyId(item.id);
    start(async () => {
      const res = await regenerateDraft(item.id, oneOffs[item.id]?.trim() || undefined);
      setBusyId(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      clearBuf(item.id);
      setOneOffs((p) => ({ ...p, [item.id]: "" }));
      setMessage(
        res.styleAdjusted
          ? "Regenerated. Style rules were applied automatically."
          : "Regenerated.",
      );
      router.refresh();
    });
  }

  function send(item: Outreach) {
    clearMsgs();
    setBusyId(item.id);
    start(async () => {
      // Persist any unsaved edits first so we send exactly what's shown.
      const buf = getBuf(item);
      if (buf.subject !== item.subject || buf.body !== item.body) {
        const upd = await updateDraft(item.id, buf.subject, buf.body);
        if (upd.error) {
          setBusyId(null);
          setError(upd.error);
          return;
        }
      }
      const res = await approveAndSend(item.id);
      setBusyId(null);
      if (res.error) {
        setError(res.error);
        router.refresh();
        return;
      }
      clearBuf(item.id);
      setMessage("Sent ✓ Lead advanced to Reached out.");
      router.refresh();
    });
  }

  function contactFor(item: Outreach): Contact | null {
    return contacts.find((c) => c.id === item.contact_id) ?? null;
  }

  const inputClass =
    "w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="space-y-4">
      {/* New draft controls */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          {contacts.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-zinc-500">
                Address to
              </label>
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                className="mt-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
              >
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name ?? c.role ?? "Contact"}
                    {c.email ? ` <${c.email}>` : " (no email)"}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex-1">
            <label className="block text-xs font-medium text-zinc-500">
              One-off instruction (optional)
            </label>
            <input
              value={newOneOff}
              onChange={(e) => setNewOneOff(e.target.value)}
              placeholder="e.g. mention their upcoming centennial"
              className={`mt-1 ${inputClass}`}
            />
          </div>
          <button
            onClick={draftNew}
            disabled={pending}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busyId === "new" && pending ? "Drafting…" : "Draft Outreach"}
          </button>
        </div>
        {busyId === "new" && pending && (
          <p className="mt-2 text-sm text-zinc-500">
            Researching the org with web search and writing a tailored email…
          </p>
        )}
      </div>

      {message && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Outreach history */}
      {outreach.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No outreach yet. Click <span className="font-medium">Draft Outreach</span>{" "}
          to generate a tailored email.
        </p>
      ) : (
        <div className="space-y-3">
          {outreach.map((item) => {
            const buf = getBuf(item);
            const contact = contactFor(item);
            const hasEmail = looksLikeRealEmail(contact?.email);
            const editable = item.status !== "sent";
            const isBusy = busyId === item.id && pending;

            return (
              <div
                key={item.id}
                className="rounded-lg border border-zinc-200 bg-white p-4"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <OutreachStatusBadge status={item.status} />
                    <span>
                      {contact
                        ? `To ${contact.name ?? contact.role ?? "contact"}${
                            contact.email ? ` <${contact.email}>` : ""
                          }`
                        : "No contact"}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-400">
                    {item.status === "sent" && item.sent_at
                      ? `Sent ${formatDateTime(item.sent_at)}`
                      : `Created ${formatDateTime(item.created_at)}`}
                  </span>
                </div>

                {editable ? (
                  <div className="space-y-2">
                    <input
                      value={buf.subject}
                      onChange={(e) =>
                        setBuf(item.id, { subject: e.target.value }, item)
                      }
                      className={inputClass}
                      placeholder="Subject"
                    />
                    <textarea
                      value={buf.body}
                      onChange={(e) =>
                        setBuf(item.id, { body: e.target.value }, item)
                      }
                      rows={12}
                      className={`${inputClass} font-mono text-[13px] leading-relaxed`}
                      placeholder="Body"
                    />

                    {!hasEmail && (
                      <p className="text-xs text-amber-700">
                        No valid email for this contact yet — resolve it above
                        before sending.
                      </p>
                    )}
                    {item.status === "failed" && item.error && (
                      <p className="text-xs text-rose-600">
                        Last send failed: {item.error}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => send(item)}
                        disabled={isBusy || !hasEmail}
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                      >
                        {isBusy ? "Working…" : "Approve & Send"}
                      </button>
                      <button
                        onClick={() => save(item)}
                        disabled={isBusy}
                        className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                      >
                        Save draft
                      </button>
                      <div className="flex flex-1 items-center gap-2">
                        <input
                          value={oneOffs[item.id] ?? ""}
                          onChange={(e) =>
                            setOneOffs((p) => ({
                              ...p,
                              [item.id]: e.target.value,
                            }))
                          }
                          placeholder="Regenerate instruction (optional)"
                          className="min-w-40 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
                        />
                        <button
                          onClick={() => regenerate(item)}
                          disabled={isBusy}
                          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                        >
                          Regenerate
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-medium text-zinc-900">
                      {item.subject}
                    </p>
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-zinc-700">
                      {item.body}
                    </pre>
                    {item.gmail_message_id && (
                      <a
                        href={`https://mail.google.com/mail/u/0/#all/${item.gmail_message_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-block text-xs text-blue-600 hover:underline"
                      >
                        Open in Gmail →
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
