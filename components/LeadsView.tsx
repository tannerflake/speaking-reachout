"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge, TypeBadge } from "@/components/Badge";
import { bulkDraft } from "@/app/actions/outreach";
import { LEAD_STATUSES } from "@/lib/types";
import type { LeadListRow } from "@/lib/data";
import type { LeadStatus, LeadType } from "@/lib/types";
import { formatDateTime, statusLabel } from "@/lib/utils";

const TYPES: LeadType[] = ["event", "institution", "other"];

export function LeadsView({
  rows,
  countries,
  initialStatus,
}: {
  rows: LeadListRow[];
  countries: string[];
  initialStatus?: LeadStatus;
}) {
  const [status, setStatus] = useState<string>(initialStatus ?? "");
  const [type, setType] = useState<string>("");
  const [country, setCountry] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status && r.status !== status) return false;
      if (type && r.type !== type) return false;
      if (country && r.location_country !== country) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, status, type, country, search]);

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
          onChange={(e) => setStatus(e.target.value)}
          className={selectClass}
        >
          <option value="">All statuses</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className={selectClass}
        >
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className={selectClass}
        >
          <option value="">All countries</option>
          {countries.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
          <span className="text-blue-800">{selected.size} selected</span>
          <button
            onClick={runBulkDraft}
            disabled={pending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {pending ? "Drafting…" : `Draft Outreach for ${selected.size}`}
          </button>
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
              <th>Contacts</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-zinc-500">
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
                    <Link
                      href={`/admin/leads/${r.id}`}
                      className="font-medium text-blue-600 hover:underline"
                    >
                      {r.name}
                    </Link>
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
                  <td className="text-zinc-600">{r.contactsCount}</td>
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
