import Link from "next/link";
import { redirect } from "next/navigation";
import { getPipelineCounts, getRecentInteractions } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth/profile";
import { PIPELINE_STATUSES } from "@/lib/types";
import { statusClasses, statusLabel, formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Route editors (Jeff) straight to the site editor; CRM admins see the CRM.
  const me = await getCurrentUser();
  if (me?.role === "editor") redirect("/admin/site-editor");

  const [counts, activity] = await Promise.all([
    getPipelineCounts(),
    getRecentInteractions(15),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Dashboard</h1>
      </div>

      {/* Pipeline summary */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-500">Pipeline</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {PIPELINE_STATUSES.map((s) => (
            <Link
              key={s}
              href={`/admin/leads?status=${s}`}
              className="rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-zinc-300"
            >
              <div className="text-2xl font-semibold text-zinc-900">
                {counts[s]}
              </div>
              <div
                className={`mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusClasses(
                  s,
                )}`}
              >
                {statusLabel(s)}
              </div>
            </Link>
          ))}
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          {counts.not_interested} marked not interested.
        </p>
      </section>

      {/* Quick actions */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-500">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/admin/discover"
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Discover leads
          </Link>
          <Link
            href="/admin/leads"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            View leads
          </Link>
          <Link
            href="/admin/settings/tailoring"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Tailoring settings
          </Link>
        </div>
      </section>

      {/* Recent activity */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-500">
          Recent activity
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white">
          {activity.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500">
              No activity yet. Run Discover to generate your first leads.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {activity.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start justify-between gap-4 px-4 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <span className="text-zinc-800">{a.detail}</span>{" "}
                    {a.lead && a.lead_id && (
                      <Link
                        href={`/admin/leads/${a.lead_id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {a.lead.name}
                      </Link>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-zinc-400">
                    {formatDateTime(a.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
