import Link from "next/link";
import { listInquiries } from "@/lib/data";
import { InquiryBadge, StatusBadge } from "@/components/Badge";
import { NON_BOOKING_NOTE } from "@/lib/leads/kind";

export const dynamic = "force-dynamic";

function phoenixDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: "America/Phoenix",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function excerpt(text: string | null, max = 140): string {
  if (!text) return "";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Press, interview/student and other non-booking inquiries from the
 * jeffflake.com "Press & other inquiries" form. Handled by hand: none of
 * these ever enter outreach, contact finding, follow-ups or pipeline stats.
 */
export default async function InquiriesPage() {
  const rows = await listInquiries();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Inquiries</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {NON_BOOKING_NOTE} Newest first; times in Arizona time.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
          No inquiries yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs font-medium text-zinc-500">
              <tr>
                <th className="px-3 py-2">Received</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Phone</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Message</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-zinc-500">
                    {phoenixDateTime(r.created_at)}
                  </td>
                  <td className="px-3 py-2 font-medium text-zinc-800">
                    {r.contactName ?? r.name}
                  </td>
                  <td className="px-3 py-2">
                    {r.email ? (
                      <a href={`mailto:${r.email}`} className="text-blue-600 hover:underline">
                        {r.email}
                      </a>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-zinc-600">
                    {r.phone || <span className="text-zinc-400">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <InquiryBadge lead={{ kind: "inquiry", inquiry_type: r.inquiry_type }} />
                  </td>
                  <td className="max-w-md px-3 py-2 text-zinc-600">{excerpt(r.message)}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link
                      href={`/admin/leads/${r.id}`}
                      className="text-blue-600 hover:underline"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
