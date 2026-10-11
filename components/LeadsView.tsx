"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ContactGapBadge,
  OriginBadge,
  SourceBadge,
  StatusBadge,
  TypeBadge,
} from "@/components/Badge";
import { bulkDraft } from "@/app/actions/outreach";
import { bulkDeleteLeads } from "@/app/actions/leads";
import { bulkFindContacts } from "@/app/actions/contacts";
import { LEAD_STATUSES } from "@/lib/types";
import type { LeadListRow } from "@/lib/data";
import type { LeadStatus } from "@/lib/types";
import { formatDateTime, statusLabel } from "@/lib/utils";

// "drafted" is a synthetic filter (new leads with an unsent draft), not a real
// lead status — so the dropdown value is a status OR this sentinel.
const STATUS_FILTER_KEY = "leads:statusFilter";
const SOURCE_FILTER_KEY = "leads:sourceFilter";
// Who started the conversation (commission): app / gmail / nothing sent yet.
const ORIGIN_FILTER_KEY = "leads:originFilter";

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
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
  }, [rows, status, source, origin, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
    start(async () => {
      const res = await bulkDraft(ids);
      setMsg(
        `Drafted ${res.created} outreach email${res.created === 1 ? "" : "s"}${
          res.failed ? `, ${res.failed} failed` : ""
        }. Open a lead to review and send.`,
      );
      setSelected(new Set());
      router.refresh();
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
    const ok = window.confirm(
      `Look up contact emails for ${needing} lead${
        needing === 1 ? "" : "s"
      } via the configured provider? Each lookup costs one paid credit. Leads that already have an email are skipped.`,
    );
    if (!ok) return;
    setMsg(null);
    start(async () => {
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
    });
  }

  function runBulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Permanently delete ${ids.length} lead${
        ids.length === 1 ? "" : "s"
      }? This also removes their contacts, outreach, and bookings. This cannot be undone.`,
    );
    if (!ok) return;
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
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
          <span className="text-blue-800">{selected.size} selected</span>
          <div className="flex items-center gap-2">
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
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {pending ? "Drafting…" : `Draft Outreach for ${selected.size}`}
            </button>
          </div>
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
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center text-zinc-500">
                  No leads match. Run{" "}
                  <Link href="/admin/discover" className="text-blue-600 hover:underline">
                    Discover
                  </Link>{" "}
                  to add some.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
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
                      <SourceBadge source={r.source} />
                    </div>
                  </td>
                  <td>
                    <TypeBadge type={r.type} />
                  </td>
                  <td className="text-zinc-600">
                    {r.location_country ?? "—"}
                  </td>
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
