import { listLeads, listCountries } from "@/lib/data";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/types";
import { LeadsView } from "@/components/LeadsView";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const initialStatus = LEAD_STATUSES.includes(status as LeadStatus)
    ? (status as LeadStatus)
    : undefined;

  const [rows, countries] = await Promise.all([listLeads({}), listCountries()]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Leads</h1>
      </div>
      <LeadsView rows={rows} countries={countries} initialStatus={initialStatus} />
    </div>
  );
}
