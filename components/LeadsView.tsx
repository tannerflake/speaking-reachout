"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ContactGapBadge,
  DraftGapBadge,
  OriginBadge,
  QueuedBadge,
  SourceBadge,
  StatusBadge,
  TypeBadge,
  WorkingBadge,
} from "@/components/Badge";
import type { WorkKind } from "@/components/Badge";
import {
  bulkDraft,
  cancelSendQueue,
  drainSendQueue,
  queueSendForLeads,
  sendQueueStatus,
} from "@/app/actions/outreach";
import { enrichLead } from "@/app/actions/pipeline";
import type { QueueStatus } from "@/lib/outreach/send";
import { bulkDeleteLeads } from "@/app/actions/leads";
import { bulkFindContacts } from "@/app/actions/contacts";
import { LEAD_STATUSES } from "@/lib/types";
import type { LeadListRow } from "@/lib/data";
import type { LeadStatus } from "@/lib/types";
import { formatDateTime, statusLabel } from "@/lib/utils";
import { useInlineConfirm } from "@/components/InlineConfirm";

// Send-queue pacing options offered in the bulk bar (minutes to spread over).
const SPREAD_OPTIONS = [
  { value: 5, label: "over 5 min" },
  { value: 10, label: "over 10 min" },
  { value: 15, label: "over 15 min" },
  { value: 30, label: "over 30 min" },
  { value: 60, label: "over 1 hour" },
  { value: 120, label: "over 2 hours" },
];

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

// "drafted" is a synthetic filter (new leads with an unsent draft), not a real
// lead status — so the dropdown value is a status OR this sentinel.
const STATUS_FILTER_KEY = "leads:statusFilter";
const SOURCE_FILTER_KEY = "leads:sourceFilter";
// Who started the conversation (commission): app / gmail / nothing sent yet.
const ORIGIN_FILTER_KEY = "leads:originFilter";
// Last-activity date range, stored as "YYYY-MM-DD" strings (empty = open end).
const DATE_FROM_KEY = "leads:dateFrom";
const DATE_TO_KEY = "leads:dateTo";

/** Local calendar date as "YYYY-MM-DD" (what <input type="date"> uses). */
function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateInput(d);
}

// Quick presets for the date range; "to" is left open so new activity keeps
// showing up without touching the filter.
const DATE_PRESETS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export function LeadsView({
  rows,
  initialStatus,
}: {
  rows: LeadListRow[];
  initialStatus?: LeadStatus | "drafted";
}) {
  const [status, setStatus] = useState<string>(initialStatus ?? "");
  const [source, setSource] = useState<string>("");
  const [origin, setOrigin] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [spread, setSpread] = useState<number>(60);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  // Leads with client-side work in flight (contact lookup / drafting /
  // prepare), so each row shows it and the operator doesn't start it twice.
  const [working, setWorking] = useState<Map<string, WorkKind>>(new Map());
  // Anchor for shift-click range selection (index into the filtered list).
  const lastClickRef = useRef<number | null>(null);
  const router = useRouter();
  const { ask, confirmEl } = useInlineConfirm();

  function markWorking(ids: string[], kind: WorkKind) {
    setWorking((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, kind);
      return next;
    });
  }
  function clearWorking(ids: string[]) {
    setWorking((prev) => {
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  // --- Send queue: poll while anything is queued and drain what is due. The
  // cron route does the same on a schedule, so closing the tab is fine.
  const refreshQueue = useCallback(async () => {
    try {
      const status = await sendQueueStatus();
      setQueue(status);
      if (status.due > 0) {
        const res = await drainSendQueue();
        if (res.sent || res.failed) {
          setQueue(await sendQueueStatus());
          router.refresh();
        }
      }
    } catch (e) {
      // Usually transient (next tick retries), but say so rather than hide it.
      setMsg(
        `Send queue check failed: ${e instanceof Error ? e.message : "request failed"}`,
      );
    }
  }, [router]);

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  useEffect(() => {
    if (!queue || queue.queued === 0) return;
    const id = setInterval(() => void refreshQueue(), 20_000);
    return () => clearInterval(id);
  }, [queue, refreshQueue]);

  // Persist the chosen filter so it survives navigating away and back. A status
  // in the URL (e.g. linked from the dashboard) wins and is remembered;
  // otherwise restore the last selection from localStorage.
  useEffect(() => {
    if (initialStatus) {
      localStorage.setItem(STATUS_FILTER_KEY, initialStatus);
    } else {
      const saved = localStorage.getItem(STATUS_FILTER_KEY);
      if (saved) setStatus(saved);
    }
    const savedSource = localStorage.getItem(SOURCE_FILTER_KEY);
    if (savedSource) setSource(savedSource);
    const savedOrigin = localStorage.getItem(ORIGIN_FILTER_KEY);
    if (savedOrigin) setOrigin(savedOrigin);
    const savedFrom = localStorage.getItem(DATE_FROM_KEY);
    if (savedFrom) setDateFrom(savedFrom);
    const savedTo = localStorage.getItem(DATE_TO_KEY);
    if (savedTo) setDateTo(savedTo);
  }, [initialStatus]);

  function changeStatus(value: string) {
    setStatus(value);
    localStorage.setItem(STATUS_FILTER_KEY, value);
  }

  function changeSource(value: string) {
    setSource(value);
    localStorage.setItem(SOURCE_FILTER_KEY, value);
  }

  function changeOrigin(value: string) {
    setOrigin(value);
    localStorage.setItem(ORIGIN_FILTER_KEY, value);
  }

  function changeDateRange(from: string, to: string) {
    setDateFrom(from);
    setDateTo(to);
    localStorage.setItem(DATE_FROM_KEY, from);
    localStorage.setItem(DATE_TO_KEY, to);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Date inputs are local calendar days; compare against the start of the
    // "from" day and the end of the "to" day so both ends are inclusive.
    const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toMs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;
    return rows.filter((r) => {
      if (fromMs !== null || toMs !== null) {
        const t = new Date(r.lastActivity).getTime();
        if (Number.isNaN(t)) return false;
        if (fromMs !== null && t < fromMs) return false;
        if (toMs !== null && t > toMs) return false;
      }
      if (status === "drafted") {
        if (!(r.status === "new" && r.hasUnsentDraft)) return false;
      } else if (status && r.status !== status) {
        return false;
      }
      if (source && r.source !== source) return false;
      if (origin === "unsent") {
        if (r.originatedVia) return false;
      } else if (origin && r.originatedVia !== origin) {
        return false;
      }
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, status, source, origin, search, dateFrom, dateTo]);

  /**
   * Checkbox click. Plain click toggles one row; shift-click selects (or
   * clears) every row between the last clicked row and this one, matching the
   * state the clicked row ends up in.
   */
  function handleRowClick(
    e: React.MouseEvent<HTMLInputElement>,
    index: number,
    id: string,
  ) {
    const anchor = lastClickRef.current;
    lastClickRef.current = index;
    setSelected((prev) => {
      const next = new Set(prev);
      const turnOn = !prev.has(id);
      if (e.shiftKey && anchor !== null && anchor !== index) {
        const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
        for (let i = a; i <= b; i += 1) {
          const rowId = filtered[i]?.id;
          if (!rowId) continue;
          if (turnOn) next.add(rowId);
          else next.delete(rowId);
        }
      } else if (turnOn) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((r) => r.id)));
    }
  }

  function runBulkDraft() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setMsg(null);
    markWorking(ids, "drafting");
    start(async () => {
      try {
        const res = await bulkDraft(ids);
        setMsg(
          `Drafted ${res.created} outreach email${res.created === 1 ? "" : "s"}${
            res.failed ? `, ${res.failed} failed` : ""
          }. Open a lead to review and send.`,
        );
        setSelected(new Set());
        router.refresh();
      } finally {
        clearWorking(ids);
      }
    });
  }

  function runBulkFindContacts() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const needing = filtered.filter(
      (r) => selected.has(r.id) && !r.hasContactEmail,
    ).length;
    if (needing === 0) {
      setMsg("All selected leads already have a contact email.");
      return;
    }
    ask(
      `Look up contact emails for ${needing} lead${
        needing === 1 ? "" : "s"
      } via the configured provider? Each lookup costs one paid credit. Leads that already have an email are skipped.`,
      () => {
        setMsg(null);
        // Only the leads that will actually be looked up; the rest are skipped.
        const lookingUp = filtered
          .filter((r) => selected.has(r.id) && !r.hasContactEmail)
          .map((r) => r.id);
        markWorking(lookingUp, "finding");
        start(async () => {
          try {
            const res = await bulkFindContacts(ids);
            setMsg(
              res.error
                ? `Contact lookup failed: ${res.error}`
                : `Found ${res.found} contact email${res.found === 1 ? "" : "s"}${
                    res.notFound ? `, ${res.notFound} not found` : ""
                  }${res.skipped ? `, ${res.skipped} already had one` : ""}.`,
            );
            setSelected(new Set());
            router.refresh();
          } finally {
            clearWorking(lookingUp);
          }
        });
      },
    );
  }

  /** Find contacts, then draft one email per contact, for each selected lead. */
  function runBulkEnrich() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    ask(
      `Find contacts and draft outreach for ${ids.length} lead${
        ids.length === 1 ? "" : "s"
      }? Contact finding uses the web-search models plus one paid Hunter lookup per lead where needed.`,
      () => {
        setMsg(null);
        markWorking(ids, "preparing");
        start(async () => {
          let done = 0;
          let contacts = 0;
          let drafts = 0;
          let errors = 0;
          const todo = [...ids];
          async function worker() {
            for (;;) {
              const id = todo.shift();
              if (!id) return;
              let res;
              try {
                res = await enrichLead(id);
              } finally {
                clearWorking([id]);
              }
              done += 1;
              contacts += res.contactsWithEmail;
              drafts += res.draftsCreated;
              if (res.error) errors += 1;
              setProgress(
                `Preparing ${done} of ${ids.length}: ${contacts} contacts with email, ${drafts} drafts so far…`,
              );
            }
          }
          try {
            await Promise.all([worker(), worker()]);
          } finally {
            clearWorking(ids);
            setProgress(null);
          }
          setMsg(
            `Ready to send: ${drafts} draft${drafts === 1 ? "" : "s"} across ${ids.length} lead${
              ids.length === 1 ? "" : "s"
            } (${contacts} contacts with email${errors ? `, ${errors} lead${errors === 1 ? "" : "s"} had a problem` : ""}). Select them and press Send.`,
          );
          router.refresh();
        });
      },
    );
  }

  /** Queue every unsent draft on the selected leads, spread over the chosen window. */
  function runBulkSend() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const label =
      SPREAD_OPTIONS.find((o) => o.value === spread)?.label ??
      `over ${spread} min`;
    ask(
      `Send every unsent draft on ${ids.length} lead${
        ids.length === 1 ? "" : "s"
      } from the connected Gmail, spread ${label}? Each email goes to its contact individually and starts its follow-up sequence. Leads without a draft are skipped.`,
      () => {
        setMsg(null);
        start(async () => {
          let res: Awaited<ReturnType<typeof queueSendForLeads>>;
          try {
            res = await queueSendForLeads(ids, spread);
          } catch (e) {
            setMsg(
              `Could not queue: ${e instanceof Error ? e.message : "request failed"}`,
            );
            return;
          }
          if (res.error) {
            setMsg(`Could not queue: ${res.error}`);
          } else if (res.queued === 0) {
            setMsg(
              `Nothing to send: no unsent drafts with a contact email on the selected leads${
                res.skipped
                  ? ` (${res.skipped} draft${res.skipped === 1 ? "" : "s"} lack a valid email)`
                  : ""
              }. Use "Find contacts + draft" first.`,
            );
          } else {
            setMsg(
              `Queued ${res.queued} email${res.queued === 1 ? "" : "s"}; the last one goes out around ${
                res.finishesAt ? clock(res.finishesAt) : "soon"
              }${res.skipped ? `. ${res.skipped} skipped for missing email` : ""}.`,
            );
          }
          setSelected(new Set());
          await refreshQueue();
          router.refresh();
        });
      },
    );
  }

  function runCancelQueue() {
    ask(
      "Pull every queued email back to draft? Nothing more will be sent.",
      () => {
        start(async () => {
          const res = await cancelSendQueue();
          setMsg(
            `Cancelled ${res.cancelled} queued email${res.cancelled === 1 ? "" : "s"}.`,
          );
          await refreshQueue();
          router.refresh();
        });
      },
    );
  }

  function runBulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    ask(
      `Permanently delete ${ids.length} lead${
        ids.length === 1 ? "" : "s"
      }? This also removes their contacts, outreach, and bookings. This cannot be undone.`,
      () => {
        setMsg(null);
        start(async () => {
          const res = await bulkDeleteLeads(ids);
          setMsg(
            res.error
              ? `Delete failed: ${res.error}`
              : `Deleted ${res.deleted} lead${res.deleted === 1 ? "" : "s"}.`,
          );
          setSelected(new Set());
          router.refresh();
        });
      },
    );
  }

  const selectClass =
    "rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name…"
          className={`${selectClass} min-w-48 flex-1`}
        />
        <select
          value={status}
          onChange={(e) => changeStatus(e.target.value)}
          className={selectClass}
        >
          <option value="">All statuses</option>
          <option value="drafted">Drafted</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <select
          value={source}
          onChange={(e) => changeSource(e.target.value)}
          className={selectClass}
        >
          <option value="">All sources</option>
          <option value="website_inbound">Via jeffflake.com</option>
          <option value="outbound">Outbound</option>
        </select>
        <select
          value={origin}
          onChange={(e) => changeOrigin(e.target.value)}
          className={selectClass}
          aria-label="Filter by who sent the first outreach"
        >
          <option value="">All senders</option>
          <option value="app">Sent via app</option>
          <option value="gmail">Sent from Gmail</option>
          <option value="unsent">Nothing sent yet</option>
        </select>
        <div
          className="flex items-center gap-1 text-sm text-zinc-600"
          role="group"
          aria-label="Filter by last activity date"
        >
          <input
            type="date"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(e) => changeDateRange(e.target.value, dateTo)}
            aria-label="Last activity from"
            className={selectClass}
          />
          <span className="text-zinc-400">–</span>
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(e) => changeDateRange(dateFrom, e.target.value)}
            aria-label="Last activity to"
            className={selectClass}
          />
          {DATE_PRESETS.map((p) => {
            const active = dateFrom === daysAgo(p.days) && dateTo === "";
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => changeDateRange(daysAgo(p.days), "")}
                className={`rounded-md border px-2 py-1 text-xs ${
                  active
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50"
                }`}
              >
                {p.label}
              </button>
            );
          })}
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => changeDateRange("", "")}
              className="px-1 text-xs text-zinc-500 hover:text-zinc-800"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Send queue status */}
      {queue && queue.queued > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-900">
          <span>
            Sending: {queue.queued} queued
            {queue.nextDueAt ? `, next at ${clock(queue.nextDueAt)}` : ""}
            {queue.lastDueAt ? `, done around ${clock(queue.lastDueAt)}` : ""}.
            Keeps going if you close this page.
          </span>
          <button
            onClick={runCancelQueue}
            disabled={pending}
            className="rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
          >
            Cancel remaining
          </button>
        </div>
      )}

      {confirmEl}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
          <span className="text-blue-800">
            {selected.size} selected
            <span className="ml-2 text-xs text-blue-600">
              (shift-click to select a range)
            </span>
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={runBulkDelete}
              disabled={pending}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              Delete
            </button>
            <button
              onClick={runBulkFindContacts}
              disabled={pending}
              className="rounded-md border border-blue-300 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60"
            >
              {pending ? "Working…" : `Find Contacts for ${selected.size}`}
            </button>
            <button
              onClick={runBulkDraft}
              disabled={pending}
              className="rounded-md border border-blue-300 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60"
            >
              {`Draft Only for ${selected.size}`}
            </button>
            <button
              onClick={runBulkEnrich}
              disabled={pending}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {pending
                ? "Working…"
                : `Find Contacts + Draft for ${selected.size}`}
            </button>
            <span className="inline-flex items-center overflow-hidden rounded-md border border-emerald-600">
              <button
                onClick={runBulkSend}
                disabled={pending}
                className="bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {`Send Drafts for ${selected.size}`}
              </button>
              <select
                value={spread}
                onChange={(e) => setSpread(Number(e.target.value))}
                disabled={pending}
                aria-label="Spread sends over"
                className="border-l border-emerald-700 bg-emerald-50 px-2 py-1.5 text-sm text-emerald-900 focus:outline-none"
              >
                {SPREAD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </span>
          </div>
        </div>
      )}
      {progress && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          {progress}
        </div>
      )}
      {msg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {msg}
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <table className="table-base">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  checked={
                    filtered.length > 0 && selected.size === filtered.length
                  }
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th>Name</th>
              <th>Type</th>
              <th>Country</th>
              <th>Status</th>
              <th>Sent by</th>
              <th>Contacts</th>
              <th>Drafts</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center text-zinc-500">
                  No leads match. Run{" "}
                  <Link
                    href="/admin/discover"
                    className="text-blue-600 hover:underline"
                  >
                    Discover
                  </Link>{" "}
                  to add some.
                </td>
              </tr>
            ) : (
              filtered.map((r, idx) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => undefined}
                      onClick={(e) => handleRowClick(e, idx, r.id)}
                      aria-label={`Select ${r.name}`}
                    />
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/admin/leads/${r.id}`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {r.name}
                      </Link>
                      <WorkingBadge kind={working.get(r.id)} />
                      <QueuedBadge count={r.queuedCount} />
                      <SourceBadge source={r.source} />
                    </div>
                  </td>
                  <td>
                    <TypeBadge type={r.type} />
                  </td>
                  <td className="text-zinc-600">{r.location_country ?? "—"}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>
                    {r.originatedVia ? (
                      <OriginBadge via={r.originatedVia} />
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="text-zinc-600">
                    <div className="flex items-center gap-2">
                      <span>{r.contactsCount}</span>
                      <ContactGapBadge
                        contactsCount={r.contactsCount}
                        hasContactEmail={r.hasContactEmail}
                      />
                    </div>
                  </td>
                  <td className="text-zinc-600">
                    {r.emailableContacts === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span>
                          {r.draftedContacts}/{r.emailableContacts}
                        </span>
                        <DraftGapBadge
                          emailableContacts={r.emailableContacts}
                          draftedContacts={r.draftedContacts}
                          hasUnsentDraft={r.hasUnsentDraft}
                        />
                      </div>
                    )}
                  </td>
                  <td className="text-zinc-500">
                    {formatDateTime(r.lastActivity)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-400">
        {filtered.length} of {rows.length} leads
      </p>
    </div>
  );
}
