import Link from "next/link";
import { notFound } from "next/navigation";
import { getLead, getLeadInteractions } from "@/lib/data";
import {
  ContactStatusBadge,
  StatusBadge,
  TypeBadge,
} from "@/components/Badge";
import { StatusControl } from "@/components/StatusControl";
import { OutreachManager } from "@/components/OutreachManager";
import { BookingForm } from "@/components/BookingForm";
import { ReachOutAgainButton } from "@/components/ReachOutAgainButton";
import { AddNote } from "@/components/AddNote";
import { ContactEmail } from "@/components/ContactEmail";
import { contactResolverName } from "@/lib/contacts/resolver";
import { formatDate, formatDateTime, looksLikeRealEmail } from "@/lib/utils";

export const dynamic = "force-dynamic";
// Drafting/sending outreach runs web-search generations — give it headroom.
export const maxDuration = 300;

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const lead = await getLead(id);
  if (!lead) notFound();

  const interactions = await getLeadInteractions(id);
  const hasRecurringBooking = lead.bookings.some((b) => b.is_recurring);

  // On-demand email lookup is available only when a paid provider is configured
  // and the lead has a domain to search. (Hunter is never called automatically.)
  const resolverName = contactResolverName();
  const canResolve =
    resolverName !== "claude" && Boolean(lead.website || lead.source_url);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/leads"
          className="text-sm text-blue-600 hover:underline"
        >
          ← All leads
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-900">{lead.name}</h1>
          <TypeBadge type={lead.type} />
          <StatusBadge status={lead.status} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-500">
          <span>
            {[lead.location_region, lead.location_country]
              .filter(Boolean)
              .join(", ") || "Location unknown"}
          </span>
          {lead.website && (
            <a
              href={lead.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Website
            </a>
          )}
          {lead.source_url && (
            <a
              href={lead.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              Source
            </a>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Main column */}
        <div className="space-y-6">
          {lead.description && (
            <section>
              <h2 className="mb-1 text-sm font-medium text-zinc-500">About</h2>
              <p className="text-sm text-zinc-700">{lead.description}</p>
            </section>
          )}

          {lead.fit_rationale && (
            <section>
              <h2 className="mb-1 text-sm font-medium text-zinc-500">
                Why it&apos;s a fit
              </h2>
              <p className="text-sm text-zinc-700">{lead.fit_rationale}</p>
            </section>
          )}

          {lead.suggested_topics.length > 0 && (
            <section>
              <h2 className="mb-1 text-sm font-medium text-zinc-500">
                Suggested topics
              </h2>
              <ul className="flex flex-wrap gap-2">
                {lead.suggested_topics.map((t, i) => (
                  <li
                    key={i}
                    className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs text-zinc-700"
                  >
                    {t}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Contacts */}
          <section>
            <h2 className="mb-2 text-sm font-medium text-zinc-500">Contacts</h2>
            {lead.contacts.length === 0 ? (
              <p className="text-sm text-zinc-500">No contacts.</p>
            ) : (
              <ul className="space-y-2">
                {lead.contacts.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-md border border-zinc-200 bg-white p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-medium text-zinc-800">
                          {c.name ?? "Unknown contact"}
                        </span>
                        {c.role && (
                          <span className="text-zinc-500"> · {c.role}</span>
                        )}
                      </div>
                      <ContactStatusBadge status={c.contact_status} />
                    </div>
                    {looksLikeRealEmail(c.email) ? (
                      <div className="mt-1 text-zinc-600">
                        <a
                          href={`mailto:${c.email}`}
                          className="text-blue-600 hover:underline"
                        >
                          {c.email}
                        </a>
                      </div>
                    ) : (
                      <ContactEmail
                        contactId={c.id}
                        canResolve={canResolve}
                        providerName={resolverName}
                        website={lead.website}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Outreach */}
          <section>
            <h2 className="mb-2 text-sm font-medium text-zinc-500">Outreach</h2>
            <OutreachManager
              leadId={lead.id}
              contacts={lead.contacts}
              outreach={lead.outreach}
            />
          </section>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <section className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-medium text-zinc-500">Status</h2>
            <StatusControl leadId={lead.id} current={lead.status} />
          </section>

          {/* Bookings */}
          {(lead.status === "booked" || lead.bookings.length > 0) && (
            <section className="rounded-lg border border-zinc-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-medium text-zinc-500">
                Bookings
              </h2>
              {lead.bookings.length > 0 && (
                <ul className="mb-3 space-y-2">
                  {lead.bookings.map((b) => (
                    <li
                      key={b.id}
                      className="rounded-md border border-zinc-200 p-2 text-sm"
                    >
                      <div className="font-medium text-zinc-800">
                        {b.event_name}
                        {b.is_recurring && (
                          <span className="ml-2 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                            recurring
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500">
                        {formatDate(b.event_date)}
                        {b.topic ? ` · ${b.topic}` : ""}
                        {b.fee != null ? ` · $${b.fee}` : ""}
                      </div>
                      {b.notes && (
                        <div className="mt-1 text-xs text-zinc-500">
                          {b.notes}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {hasRecurringBooking && (
                <div className="mb-3">
                  <ReachOutAgainButton leadId={lead.id} />
                </div>
              )}

              {lead.status === "booked" && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-zinc-600">
                    Add a booking
                  </summary>
                  <div className="mt-3">
                    <BookingForm leadId={lead.id} />
                  </div>
                </details>
              )}
            </section>
          )}

          {/* Activity */}
          <section className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-medium text-zinc-500">Activity</h2>
            <div className="mb-3">
              <AddNote leadId={lead.id} />
            </div>
            {interactions.length === 0 ? (
              <p className="text-sm text-zinc-400">No activity yet.</p>
            ) : (
              <ul className="space-y-2">
                {interactions.map((i) => (
                  <li key={i.id} className="text-sm">
                    <span className="text-zinc-700">{i.detail}</span>
                    <span className="ml-1 text-xs text-zinc-400">
                      {formatDateTime(i.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
