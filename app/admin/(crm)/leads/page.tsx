import { listLeads } from "@/lib/data";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/types";
import { LeadsView } from "@/components/LeadsView";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const validFilters: string[] = [...LEAD_STATUSES, "drafted"];
  const initialStatus = validFilters.includes(status ?? "")
    ? (status as LeadStatus | "drafted")
    : undefined;

  const rows = await listLeads({});

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Leads</h1>
      </div>
      <LeadsView rows={rows} initialStatus={initialStatus} />
    </div>
  );
}
