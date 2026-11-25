import Link from "next/link";
import { listLeads } from "@/lib/data";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/types";
import { LeadsView } from "@/components/LeadsView";
import { ScanEmailButton } from "@/components/ScanEmailButton";

export const dynamic = "force-dynamic";
// Server actions invoked from this page (bulk draft, contact lookup, send
// queue) inherit this limit; the default is only 10s.
export const maxDuration = 300;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; kind?: string }>;
}) {
  const { status, kind } = await searchParams;
  // Inquiries (press, interview/student, other) are hidden by default.
  const showInquiries = kind === "inquiry";
  const validFilters: string[] = [...LEAD_STATUSES, "drafted"];
  const initialStatus = validFilters.includes(status ?? "")
    ? (status as LeadStatus | "drafted")
    : undefined;

  const rows = await listLeads({ kind: showInquiries ? "inquiry" : "speaking" });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-900">
            {showInquiries ? "Leads: inquiries" : "Leads"}
          </h1>
          <div className="flex rounded-md border border-zinc-200 bg-white p-0.5 text-xs font-medium">
            <Link
              href="/admin/leads"
              className={`rounded px-2.5 py-1 ${
                showInquiries ? "text-zinc-600 hover:bg-zinc-100" : "bg-zinc-900 text-white"
              }`}
            >
              Speaking
            </Link>
            <Link
              href="/admin/leads?kind=inquiry"
              className={`rounded px-2.5 py-1 ${
                showInquiries ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
              }`}
            >
              Inquiries
            </Link>
          </div>
        </div>
        <ScanEmailButton variant="secondary" />
      </div>
      <LeadsView rows={rows} initialStatus={initialStatus} />
    </div>
  );
}
