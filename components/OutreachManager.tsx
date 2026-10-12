"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { OriginBadge, OutreachStatusBadge } from "@/components/Badge";
import Link from "next/link";
import {
  approveAndSend,
  draftForAllContacts,
  generateDraft,
  overrideAndSend,
  regenerateDraft,
  updateDraft,
} from "@/app/actions/outreach";
import type { EngagementGuardResult } from "@/lib/outreach/guard";
import type { Contact, Outreach } from "@/lib/types";
import {
  formatDateTime,
  looksLikeRealEmail,
  pickPrimaryContact,
} from "@/lib/utils";
import { useInlineConfirm } from "@/components/InlineConfirm";

interface Buf {
  subject: string;
  body: string;
}

/** Serializable guard verdict computed on the server for the lead page. */
export type GuardView =
  | { kind: "ok"; result: EngagementGuardResult }
  | { kind: "blocked"; result: EngagementGuardResult }
  | { kind: "unavailable"; error: string };

export function OutreachManager({
  leadId,
  contacts,
  outreach,
  guard,
}: {
  leadId: string;
  contacts: Contact[];
  outreach: Outreach[];
  guard: GuardView;
}) {
  const primary = pickPrimaryContact(contacts);
  // Blocked or unknown: drafting is off until the operator acknowledges, and
  // every send needs a recorded override (the server enforces both).
  const guardBlocked = guard.kind !== "ok";
  const [acknowledged, setAcknowledged] = useState(false);
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  const [contactId, setContactId] = useState<string>(primary?.id ?? "");
  const [newOneOff, setNewOneOff] = useState("");
  const [bufs, setBufs] = useState<Record<string, Buf>>({});
  const [oneOffs, setOneOffs] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { ask, confirmEl } = useInlineConfirm();

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
        { acknowledgeConflict: acknowledged },
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

  // Contacts with an email that don't have a draft or sent email yet.
  const coveredIds = new Set(outreach.map((o) => o.contact_id).filter(Boolean));
  const uncovered = contacts.filter(
    (c) => looksLikeRealEmail(c.email) && !coveredIds.has(c.id),
  );
  // When the org is in conversation, only drafts carrying an operator
  // override are sendable in bulk; the rest need an individual override.
  const sendable = outreach.filter(
    (o) =>
      o.status !== "sent" &&
      (!guardBlocked || Boolean(o.guard_override_at)) &&
      looksLikeRealEmail(contacts.find((c) => c.id === o.contact_id)?.email),
  );

  function sendWithOverride(item: Outreach) {
    const reason = (overrideReasons[item.id] ?? "").trim();
    const email = contactFor(item)?.email ?? "this contact";
    ask(
      `Send to ${email} even though this organization is already in a conversation?\n\nReason recorded: ${reason}`,
      () => {
        clearMsgs();
        setBusyId(item.id);
        start(async () => {
          const buf = getBuf(item);
          if (buf.subject !== item.subject || buf.body !== item.body) {
            const upd = await updateDraft(item.id, buf.subject, buf.body);
            if (upd.error) {
              setBusyId(null);
              setError(upd.error);
              return;
            }
          }
          const res = await overrideAndSend(item.id, reason);
          setBusyId(null);
          if (res.error) {
            setError(res.error);
            router.refresh();
            return;
          }
          clearBuf(item.id);
          setMessage("Sent with override ✓ (logged in Activity).");
          router.refresh();
        });
      },
    );
  }

  function draftAll() {
    clearMsgs();
    setBusyId("all");
    start(async () => {
      const res = await draftForAllContacts(
        leadId,
        newOneOff.trim() || undefined,
        { acknowledgeConflict: acknowledged },
      );
      setBusyId(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      setNewOneOff("");
      setMessage(
        `Created ${res.created} drafts, one per contact. Review each below before sending.`,
      );
      router.refresh();
    });
  }

  function sendAll() {
    const recipients = sendable
      .map((o) => contacts.find((c) => c.id === o.contact_id)?.email)
      .join("\n");
    ask(
      `Send ${sendable.length} separate emails to:\n\n${recipients}\n\nEach person gets their own message.`,
      () => {
        clearMsgs();
        setBusyId("sendAll");
        start(async () => {
          // Persist unsaved edits first so we send exactly what's shown.
          for (const item of sendable) {
            const buf = getBuf(item);
            if (buf.subject !== item.subject || buf.body !== item.body) {
              const upd = await updateDraft(item.id, buf.subject, buf.body);
              if (upd.error) {
                setBusyId(null);
                setError(upd.error);
                return;
              }
            }
          }
          // One request per email. A single server action that loops over every
          // draft gets killed by the hosting function time limit after a couple
          // of sends, which left the rest unsent with no error shown.
          let sent = 0;
          const errors: string[] = [];
          try {
            for (const item of sendable) {
              const email =
                contacts.find((c) => c.id === item.contact_id)?.email ?? "?";
              setMessage(
                `Sending ${sent + errors.length + 1} of ${sendable.length}: ${email}…`,
              );
              const res = await approveAndSend(item.id);
              if (res.error) errors.push(`${email}: ${res.error}`);
              else sent += 1;
            }
          } catch (e) {
            errors.push(
              e instanceof Error ? e.message : "Send request failed.",
            );
          }
          setBusyId(null);
          setBufs({});
          if (errors.length > 0) {
            setMessage(null);
            setError(
              `Sent ${sent}, ${errors.length} failed: ${errors.join("; ")}`,
            );
          } else {
            setMessage(`Sent ${sent} emails ✓ Lead advanced to Reached out.`);
          }
          router.refresh();
        });
      },
    );
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
      const res = await regenerateDraft(
        item.id,
        oneOffs[item.id]?.trim() || undefined,
      );
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
      {guard.kind === "blocked" && (
        <div className="rounded-lg border-2 border-rose-300 bg-rose-50 p-4">
          <p className="text-sm font-semibold text-rose-800">
            Do not send: this organization is already in a conversation.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-800">
            {guard.result.conflicts.map((c, i) => (
              <li key={i}>
                {c.detail}
                {c.leadId && c.leadId !== leadId && (
                  <>
                    {" "}
                    <Link
                      href={`/admin/leads/${c.leadId}`}
                      className="font-medium underline"
                    >
                      Open that lead
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
          {guard.result.siblings.length > 0 && (
            <p className="mt-2 text-xs text-rose-700">
              Same organization in the CRM:{" "}
              {guard.result.siblings.map((sib, i) => (
                <span key={sib.id}>
                  {i > 0 ? ", " : ""}
                  <Link href={`/admin/leads/${sib.id}`} className="underline">
                    {sib.name}
                  </Link>
                </span>
              ))}
              . Consider merging or marking the duplicate as Junk.
            </p>
          )}
          <p className="mt-2 text-xs text-rose-700">
            Checked: {guard.result.domains.map((d) => `@${d}`).join(", ") || "name only"}
            {guard.result.gmailChecked ? " and the Gmail mailbox." : "."}{" "}
            New drafts are off and nothing here can be sent without a recorded
            reason.
          </p>
          {!acknowledged && (
            <button
              onClick={() => setAcknowledged(true)}
              className="mt-3 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-xs font-medium text-rose-800 hover:bg-rose-100"
            >
              I understand, let me draft anyway
            </button>
          )}
        </div>
      )}
      {guard.kind === "unavailable" && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">
            Could not check whether this organization is already in a
            conversation.
          </p>
          <p className="mt-1 text-xs">{guard.error}</p>
          <p className="mt-1 text-xs">
            Sending is refused until the mailbox can be checked. Reconnect
            Gmail in Settings and reload.
          </p>
        </div>
      )}
      {guard.kind === "ok" && guard.result.siblings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Possible duplicate: the CRM also has{" "}
          {guard.result.siblings.map((sib, i) => (
            <span key={sib.id}>
              {i > 0 ? ", " : ""}
              <Link href={`/admin/leads/${sib.id}`} className="font-medium underline">
                {sib.name}
              </Link>
            </span>
          ))}{" "}
          for the same organization. Nothing there is in conversation yet, but
          sending from both leads would double up.
        </div>
      )}

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
            disabled={pending || (guardBlocked && !acknowledged)}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busyId === "new" && pending ? "Drafting…" : "Draft Outreach"}
          </button>
          {uncovered.length > 1 && (
            <button
              onClick={draftAll}
              disabled={pending || (guardBlocked && !acknowledged)}
              className="rounded-md border border-blue-600 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60"
            >
              {busyId === "all" && pending
                ? "Drafting…"
                : `Draft for all ${uncovered.length} contacts`}
            </button>
          )}
        </div>
        {(busyId === "new" || busyId === "all") && pending && (
          <p className="mt-2 text-sm text-zinc-500">
            Researching the org with web search and writing a tailored email…
          </p>
        )}
      </div>

      {confirmEl}
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

      {sendable.length > 1 && (
        <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <span className="text-sm text-blue-900">
            {sendable.length} drafts ready, each to a different contact.
          </span>
          <button
            onClick={sendAll}
            disabled={pending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {busyId === "sendAll" && pending
              ? "Sending…"
              : `Approve & send all ${sendable.length}`}
          </button>
        </div>
      )}

      {/* Outreach history */}
      {outreach.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No outreach yet. Click{" "}
          <span className="font-medium">Draft Outreach</span> to generate a
          tailored email.
        </p>
      ) : (
        <div className="space-y-3">
          {outreach.map((item) => {
            const buf = getBuf(item);
            const contact = contactFor(item);
            const hasEmail = looksLikeRealEmail(contact?.email);
            const editable = item.status !== "sent";
            const isBusy = busyId === item.id && pending;
            const needsOverride =
              editable &&
              !item.guard_override_at &&
              (guard.kind === "blocked" || item.status === "blocked");

            return (
              <div
                key={item.id}
                className="rounded-lg border border-zinc-200 bg-white p-4"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <OutreachStatusBadge status={item.status} />
                    {item.status === "sent" && (
                      <OriginBadge via={item.sent_via} />
                    )}
                    {item.sequence_step > 0 && (
                      <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                        Follow-up {item.sequence_step}
                      </span>
                    )}
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
                    {item.status === "blocked" && (
                      <p className="text-xs font-medium text-rose-700">
                        Blocked by the engagement guard: {item.error}
                      </p>
                    )}
                    {item.guard_override_at && (
                      <p className="text-xs text-amber-700">
                        Override recorded: {item.guard_override_reason}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      {needsOverride ? (
                        <>
                          <input
                            value={overrideReasons[item.id] ?? ""}
                            onChange={(e) =>
                              setOverrideReasons((p) => ({
                                ...p,
                                [item.id]: e.target.value,
                              }))
                            }
                            placeholder="Why send despite the existing conversation?"
                            className="min-w-64 flex-1 rounded-md border border-rose-300 px-2 py-1.5 text-sm"
                          />
                          <button
                            onClick={() => sendWithOverride(item)}
                            disabled={
                              isBusy ||
                              !hasEmail ||
                              (overrideReasons[item.id] ?? "").trim().length < 8
                            }
                            className="rounded-md bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-800 disabled:opacity-60"
                          >
                            {isBusy ? "Working…" : "Override & send"}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => send(item)}
                          disabled={isBusy || !hasEmail || guard.kind === "unavailable"}
                          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                        >
                          {isBusy ? "Working…" : "Approve & Send"}
                        </button>
                      )}
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
