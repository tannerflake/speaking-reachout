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
  draftForAllContacts,
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
import { MultiSelect } from "@/components/MultiSelect";

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
// lead status — so each selected value is a status OR this sentinel.
// Status, source and sender filters are multi-select; an empty list means all.
const STATUS_FILTER_KEY = "leads:statusFilter";
const SOURCE_FILTER_KEY = "leads:sourceFilter";
// Who started the conversation (commission): app / gmail / nothing sent yet.
const ORIGIN_FILTER_KEY = "leads:originFilter";
// Last-activity date range, stored as "YYYY-MM-DD" strings (empty = open end).
const DATE_FROM_KEY = "leads:dateFrom";
const DATE_TO_KEY = "leads:dateTo";
// Column sort, stored as { key, dir }.
const SORT_KEY = "leads:sort";

type SortKey =
  | "name"
  | "type"
  | "country"
  | "status"
  | "sentBy"
  | "contacts"
  | "drafts"
  | "lastActivity";
type SortDir = "asc" | "desc";
interface Sort {
  key: SortKey;
  dir: SortDir;
}

const DEFAULT_SORT: Sort = { key: "lastActivity", dir: "desc" };

// First click on a text column sorts A to Z; on a number or date column it
// puts the biggest / most recent first.
const SORT_COLUMNS: { key: SortKey; label: string; firstDir: SortDir }[] = [
  { key: "name", label: "Name", firstDir: "asc" },
  { key: "type", label: "Type", firstDir: "asc" },
  { key: "country", label: "Country", firstDir: "asc" },
  { key: "status", label: "Status", firstDir: "asc" },
  { key: "sentBy", label: "Sent by", firstDir: "asc" },
  { key: "contacts", label: "Contacts", firstDir: "desc" },
  { key: "drafts", label: "Drafts", firstDir: "desc" },
  { key: "lastActivity", label: "Last activity", firstDir: "desc" },
];

/** Compare two rows on one column, ascending. Status follows pipeline order. */
function compareRows(a: LeadListRow, b: LeadListRow, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "type":
      return (a.type ?? "").localeCompare(b.type ?? "");
    case "country":
      return (a.location_country ?? "").localeCompare(b.location_country ?? "");
    case "status":
      return LEAD_STATUSES.indexOf(a.status) - LEAD_STATUSES.indexOf(b.status);
    case "sentBy":
      return (a.originatedVia ?? "").localeCompare(b.originatedVia ?? "");
    case "contacts":
      return a.contactsCount - b.contactsCount;
    case "drafts":
      return (
        a.draftedContacts - b.draftedContacts ||
        a.emailableContacts - b.emailableContacts
      );
    case "lastActivity":
      return (
        new Date(a.lastActivity).getTime() - new Date(b.lastActivity).getTime()
      );
  }
}

function loadSort(): Sort | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SORT_KEY) ?? "");
    const s = parsed as Partial<Sort>;
    if (
      SORT_COLUMNS.some((c) => c.key === s.key) &&
      (s.dir === "asc" || s.dir === "desc")
    ) {
      return { key: s.key as SortKey, dir: s.dir };
    }
  } catch {
    // nothing saved yet
  }
  return null;
}

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
  { label: "1d", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
];

/**
 * Read a saved multi-select filter. Older versions stored a single string
 * ("" for all), so accept that too.
 */
function loadList(key: string): string[] | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
  } catch {
    // legacy plain string
  }
  return raw ? [raw] : [];
}

const SOURCE_OPTIONS = [
  { value: "website_inbound", label: "Via jeffflake.com" },
  { value: "outbound", label: "Outbound" },
];

const ORIGIN_OPTIONS = [
  { value: "app", label: "Sent via app" },
  { value: "gmail", label: "Sent from Gmail" },
  { value: "unsent", label: "Nothing sent yet" },
];

export function LeadsView({
  rows,
  initialStatus,
}: {
  rows: LeadListRow[];
  initialStatus?: LeadStatus | "drafted";
}) {
  const [status, setStatus] = useState<string[]>(
    initialStatus ? [initialStatus] : [],
  );
  const [source, setSource] = useState<string[]>([]);
  const [origin, setOrigin] = useState<string[]>([]);
  const [search, setSearch] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
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
        if (res.sent || res.failed || res.blocked || res.deferred) {
          setQueue(await sendQueueStatus());
          if (res.blocked) {
            setMsg(
              `${res.blocked} queued email${res.blocked === 1 ? " was" : "s were"} blocked: the organization is already in a conversation. Open the lead to see why.`,
            );
          } else if (res.deferred) {
            setMsg(
              `Sending paused: the mailbox could not be checked for existing conversations. It will retry shortly. ${res.errors[0] ?? ""}`,
            );
          }
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
      localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify([initialStatus]));
    } else {
      const saved = loadList(STATUS_FILTER_KEY);
      if (saved) setStatus(saved);
    }
    const savedSource = loadList(SOURCE_FILTER_KEY);
    if (savedSource) setSource(savedSource);
    const savedOrigin = loadList(ORIGIN_FILTER_KEY);
    if (savedOrigin) setOrigin(savedOrigin);
    const savedFrom = localStorage.getItem(DATE_FROM_KEY);
    if (savedFrom) setDateFrom(savedFrom);
    const savedTo = localStorage.getItem(DATE_TO_KEY);
    if (savedTo) setDateTo(savedTo);
    const savedSort = loadSort();
    if (savedSort) setSort(savedSort);
  }, [initialStatus]);

  /** Header click: same column flips direction, a new column starts fresh. */
  function changeSort(key: SortKey) {
    const col = SORT_COLUMNS.find((c) => c.key === key);
    const next: Sort =
      sort.key === key
        ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
        : { key, dir: col?.firstDir ?? "asc" };
    setSort(next);
    lastClickRef.current = null;
    localStorage.setItem(SORT_KEY, JSON.stringify(next));
  }

  function changeStatus(value: string[]) {
    setStatus(value);
    localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify(value));
  }

  function changeSource(value: string[]) {
    setSource(value);
    localStorage.setItem(SOURCE_FILTER_KEY, JSON.stringify(value));
  }

  function changeOrigin(value: string[]) {
    setOrigin(value);
    localStorage.setItem(ORIGIN_FILTER_KEY, JSON.stringify(value));
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
    const matching = rows.filter((r) => {
      if (fromMs !== null || toMs !== null) {
        const t = new Date(r.lastActivity).getTime();
        if (Number.isNaN(t)) return false;
        if (fromMs !== null && t < fromMs) return false;
        if (toMs !== null && t > toMs) return false;
      }
      // Within one filter the selected values are OR'd; filters are AND'd.
      if (
        status.length > 0 &&
        !status.some((s) =>
          s === "drafted"
            ? r.status === "new" && r.hasUnsentDraft
            : r.status === s,
        )
      ) {
        return false;
      }
      if (source.length > 0 && !source.includes(r.source)) return false;
      if (
        origin.length > 0 &&
        !origin.some((o) =>
          o === "unsent" ? !r.originatedVia : r.originatedVia === o,
        )
      ) {
        return false;
      }
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
    // Ties fall back to most recent activity so the order is stable.
    const sign = sort.dir === "asc" ? 1 : -1;
    return matching.sort(
      (a, b) =>
        sign * compareRows(a, b, sort.key) ||
        compareRows(b, a, "lastActivity"),
    );
  }, [rows, status, source, origin, search, dateFrom, dateTo, sort]);

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

  /**
   * Get each selected lead to "has contacts and drafts", then queue every
   * unsent draft, spread over the chosen window. Per lead: no emailable
   * contact means find contacts + draft (paid lookups); emailable contacts
   * without a draft means draft only; otherwise it is ready as-is. Leads
   * that already have a sent email are never prepped (the engagement guard
   * would block their sends anyway, so a lookup would be wasted spend).
   */
  function runBulkSend() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const label =
      SPREAD_OPTIONS.find((o) => o.value === spread)?.label ??
      `over ${spread} min`;
    const chosen = filtered.filter((r) => selected.has(r.id));
    const toFind = chosen
      .filter((r) => !r.originatedVia && r.emailableContacts === 0)
      .map((r) => r.id);
    const toDraft = chosen
      .filter(
        (r) =>
          !r.originatedVia &&
          r.emailableContacts > 0 &&
          r.draftedContacts < r.emailableContacts,
      )
      .map((r) => r.id);
    const prepNotes = [
      toFind.length
        ? `find contacts and draft for ${toFind.length} (uses paid lookups)`
        : "",
      toDraft.length ? `draft for ${toDraft.length}` : "",
    ].filter(Boolean);
    ask(
      `${prepNotes.length ? `First ${prepNotes.join(", then ")}. Then send` : "Send"} every unsent draft on ${ids.length} lead${
        ids.length === 1 ? "" : "s"
      } from the connected Gmail, spread ${label}? Each email goes to its contact individually and starts its follow-up sequence.`,
      () => {
        setMsg(null);
        markWorking(toFind, "preparing");
        markWorking(toDraft, "drafting");
        start(async () => {
          // Prep phase: same two-at-a-time pacing as "Find Contacts + Draft".
          const prepTotal = toFind.length + toDraft.length;
          let prepDone = 0;
          let drafts = 0;
          let prepErrors = 0;
          const todo = [
            ...toFind.map((id) => ({ id, find: true })),
            ...toDraft.map((id) => ({ id, find: false })),
          ];
          async function worker() {
            for (;;) {
              const job = todo.shift();
              if (!job) return;
              try {
                if (job.find) {
                  const res = await enrichLead(job.id);
                  drafts += res.draftsCreated;
                  if (res.error) prepErrors += 1;
                } else {
                  const res = await draftForAllContacts(job.id);
                  drafts += res.created;
                  if (res.error && res.created === 0) prepErrors += 1;
                }
              } catch {
                prepErrors += 1;
              } finally {
                clearWorking([job.id]);
              }
              prepDone += 1;
              setProgress(
                `Preparing ${prepDone} of ${prepTotal} before sending: ${drafts} new draft${drafts === 1 ? "" : "s"} so far…`,
              );
            }
          }
          if (prepTotal > 0) {
            try {
              await Promise.all([worker(), worker()]);
            } finally {
              clearWorking([...toFind, ...toDraft]);
              setProgress(null);
            }
          }
          const prepSummary = prepTotal
            ? `Prepared ${prepTotal} lead${prepTotal === 1 ? "" : "s"} (${drafts} new draft${drafts === 1 ? "" : "s"}${
                prepErrors ? `, ${prepErrors} had a problem` : ""
              }). `
            : "";

          let res: Awaited<ReturnType<typeof queueSendForLeads>>;
          try {
            res = await queueSendForLeads(ids, spread);
          } catch (e) {
            setMsg(
              `${prepSummary}Could not queue: ${e instanceof Error ? e.message : "request failed"}`,
            );
            router.refresh();
            return;
          }
          if (res.error) {
            setMsg(`${prepSummary}Could not queue: ${res.error}`);
          } else if (res.queued === 0) {
            setMsg(
              prepSummary +
                (res.blocked
                  ? `Nothing queued: ${res.blocked} draft${res.blocked === 1 ? " was" : "s were"} blocked because the organization is already in a conversation${
                      res.skipped ? `, and ${res.skipped} lack a valid email` : ""
                    }. Open the lead to see why.`
                  : `Nothing to send: no unsent drafts with a contact email on the selected leads${
                      res.skipped
                        ? ` (${res.skipped} draft${res.skipped === 1 ? "" : "s"} lack a valid email)`
                        : ""
                    }.`),
            );
          } else {
            setMsg(
              `${prepSummary}Queued ${res.queued} email${res.queued === 1 ? "" : "s"}; the last one goes out around ${
                res.finishesAt ? clock(res.finishesAt) : "soon"
              }${res.skipped ? `. ${res.skipped} skipped for missing email` : ""}${
                res.blocked
                  ? `. ${res.blocked} blocked: already in conversation with that organization`
                  : ""
              }.`,
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
        <MultiSelect
          value={status}
          onChange={changeStatus}
          options={[
            { value: "drafted", label: "Drafted" },
            ...LEAD_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
          ]}
          allLabel="All statuses"
          noun="statuses"
          ariaLabel="Filter by status"
          className={selectClass}
        />
        <MultiSelect
          value={source}
          onChange={changeSource}
          options={SOURCE_OPTIONS}
          allLabel="All sources"
          noun="sources"
          ariaLabel="Filter by source"
          className={selectClass}
        />
        <MultiSelect
          value={origin}
          onChange={changeOrigin}
          options={ORIGIN_OPTIONS}
          allLabel="All senders"
          noun="senders"
          ariaLabel="Filter by who sent the first outreach"
          className={selectClass}
        />
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
                {pending ? "Working…" : `Prepare + Send for ${selected.size}`}
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
              {SORT_COLUMNS.map((c) => {
                const active = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    aria-sort={
                      active
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={() => changeSort(c.key)}
                      className={`inline-flex items-center gap-1 hover:text-zinc-900 ${
                        active ? "text-zinc-900" : ""
                      }`}
                    >
                      {c.label}
                      <span
                        className={active ? "text-zinc-700" : "text-zinc-300"}
                        aria-hidden
                      >
                        {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  </th>
                );
              })}
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
