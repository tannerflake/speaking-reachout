import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ReplyThreads } from "@/components/ReplyThreads";
import {
  alreadyInContactReasons,
  getLead,
  getLeadFollowups,
  getLeadInteractions,
} from "@/lib/data";
import {
  ContactStatusBadge,
  MergedBadge,
  OriginBadge,
  QueuedBadge,
  ReferredBadge,
  HolidayOooBadge,
  InquiryBadge,
  RevisitBadge,
  SourceBadge,
  StatusBadge,
  TypeBadge,
} from "@/components/Badge";
import { AddReferredContact } from "@/components/AddReferredContact";
import { LeadAdvancedPanel } from "@/components/LeadAdvancedPanel";
import {
  effectiveOrigin,
  firstSentChannel,
  isAttributionHistory,
} from "@/lib/attribution";
import { StatusControl } from "@/components/StatusControl";
import { RevisitDateControl } from "@/components/RevisitDateControl";
import { OutreachManager, type GuardView } from "@/components/OutreachManager";
import { createClient } from "@/lib/supabase/server";
import {
  EngagementGuardUnavailableError,
  checkEngagementGuard,
  markLeadAlreadyInContact,
  summarizeConflicts,
} from "@/lib/outreach/guard";
import { BookingForm } from "@/components/BookingForm";
import { ReachOutAgainButton } from "@/components/ReachOutAgainButton";
import { AddNote } from "@/components/AddNote";
import { FollowupsPanel } from "@/components/FollowupsPanel";
import { ContactEmail } from "@/components/ContactEmail";
import { ContactRelookup } from "@/components/ContactRelookup";
import { contactResolverName } from "@/lib/contacts/resolver";
import { FindContactsButton } from "@/components/FindContactsButton";
import {
  MAX_CONTACTS_PER_LEAD,
  availableContactSources,
} from "@/lib/contacts/multiSource";
import { getEnv } from "@/lib/env";
import { NON_BOOKING_NOTE, inquiryLeadIds } from "@/lib/leads/kind";
import { formatDate, formatDateTime, looksLikeRealEmail } from "@/lib/utils";

export const dynamic = "force-dynamic";
// Drafting/sending outreach runs web-search generations — give it headroom.
export const maxDuration = 300;

/**
 * Engagement guard verdict for the banner: CRM siblings plus the live
 * mailbox. The send path re-runs the same check, so this is advisory for
 * the operator and never the only line of defense.
 */
async function loadGuard(leadId: string): Promise<GuardView> {
  try {
    const supabase = await createClient();
    const result = await checkEngagementGuard(supabase, leadId);
    // A definite conflict takes the lead out of sending for good (only a
    // "couldn't check" error, below, leaves it alone).
    if (result.blocked) {
      await markLeadAlreadyInContact(supabase, leadId, summarizeConflicts(result));
    }
    return { kind: result.blocked ? "blocked" : "ok", result };
  } catch (e) {
    const error =
      e instanceof EngagementGuardUnavailableError
        ? e.message
        : e instanceof Error
          ? e.message
          : "Check failed.";
    return { kind: "unavailable", error };
  }
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Non-booking inquiries skip the engagement guard (no outreach, and it must
  // never move them to Already in contact).
  const inquiry = (await inquiryLeadIds(await createClient(), [id])).has(id);

  // The guard runs first: it may move the lead to Already in contact, and
  // the page should show the status and activity it just wrote.
  const checked: GuardView = inquiry
    ? { kind: "unavailable", error: NON_BOOKING_NOTE }
    : await loadGuard(id);
  const lead = await getLead(id);
  if (!lead) notFound();
  const [interactions, followups, blockedReasons] = await Promise.all([
    getLeadInteractions(id),
    getLeadFollowups(id),
    alreadyInContactReasons(await createClient(), [id]),
  ]);
  const blockedReason =
    lead.status === "blocked"
      ? (blockedReasons.get(id) ??
        (checked.kind === "blocked" ? summarizeConflicts(checked.result) : null) ??
        lead.outreach.find((o) => o.status === "blocked")?.error ??
        "Flagged by the engagement guard.")
      : null;
  // Blocked sticks even when today's check comes back clean.
  const guard: GuardView =
    blockedReason && checked.kind !== "blocked"
      ? { kind: "flagged", reason: blockedReason }
      : checked;
  const hasRecurringBooking = lead.bookings.some((b) => b.is_recurring);
  const origin = effectiveOrigin(lead, firstSentChannel(lead.outreach));
  const attributionHistory = interactions.filter((i) => isAttributionHistory(i.detail));
  const contactName = (id: string | null | undefined) => {
    const c = lead.contacts.find((x) => x.id === id);
    return c ? c.name || c.email || "a contact" : "a contact";
  };
  // A merged duplicate points at the lead that now holds its history.
  let mergedInto: { id: string; name: string } | null = null;
  if (lead.merged_into_id) {
    const { data } = await (await createClient())
      .from("leads")
      .select("id, name")
      .eq("id", lead.merged_into_id)
      .maybeSingle();
    mergedInto = (data as { id: string; name: string } | null) ?? {
      id: lead.merged_into_id,
      name: "the target lead",
    };
  }

  // On-demand email lookup is available only when a paid provider is configured
  // and the lead has a domain to search. (Hunter is never called automatically.)
  const resolverName = contactResolverName();
  const canResolve =
    !inquiry && resolverName !== "claude" && Boolean(lead.website || lead.source_url);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/admin/leads"
          className="text-sm text-blue-600 hover:underline"
        >
          ← All leads
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-900">{lead.name}</h1>
          <QueuedBadge
            count={lead.outreach.filter((o) => o.status === "queued").length}
          />
          <InquiryBadge lead={lead} />
          <TypeBadge type={lead.type} />
          <StatusBadge status={lead.status} />
          <SourceBadge source={lead.source} />
          <OriginBadge
            via={origin.via}
            overridden={origin.overridden}
            reason={origin.reason}
          />
          {mergedInto && <MergedBadge />}
          <RevisitBadge on={lead.revisit_on} note={lead.revisit_note} />
        </div>
        {inquiry && (
          <p className="mt-2 rounded-md border border-fuchsia-200 bg-fuchsia-50 px-3 py-2 text-sm text-fuchsia-900">
            <span className="font-semibold">{NON_BOOKING_NOTE}</span> Outreach
            drafting, contact finding, sending and follow-ups are off for this
            lead.
          </p>
        )}
        {mergedInto && (
          <p className="mt-2 rounded-md border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm text-zinc-800">
            <span className="font-semibold">Merged into </span>
            <Link
              href={`/admin/leads/${mergedInto.id}`}
              className="font-semibold text-blue-600 hover:underline"
            >
              {mergedInto.name}
            </Link>
            . This duplicate is kept for the record; its contacts, outreach and
            activity now live on that lead.
          </p>
        )}
        {origin.overridden && (
          <p className="mt-2 text-xs text-zinc-500">
            Attribution overridden to {origin.via === "app" ? "Sent via app" : "Not via app"}
            {origin.by ? ` by ${origin.by}` : ""}: {origin.reason}
          </p>
        )}
        {blockedReason && (
          <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            <span className="font-semibold">Already in contact.</span>{" "}
            {blockedReason} This lead is out of sending and Discover until
            someone changes its status.
          </p>
        )}
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

      {/* Replies, read live from Gmail; streams in so the rest of the page
          doesn't wait on the mailbox. */}
      {lead.outreach.some((o) => o.status === "sent") && (
        <Suspense
          fallback={
            <p className="text-sm text-zinc-400">Checking Gmail for replies…</p>
          }
        >
          <ReplyThreads lead={lead} interactions={interactions} />
        </Suspense>
      )}

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
            {!inquiry && (
              <FindContactsButton
                leadId={lead.id}
                sources={availableContactSources()}
                max={MAX_CONTACTS_PER_LEAD}
                hunterAvailable={
                  Boolean(getEnv("HUNTER_API_KEY")) &&
                  Boolean(lead.website || lead.source_url)
                }
              />
            )}
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
                      <div className="flex flex-wrap items-center gap-1.5">
                        {c.referred_by_contact_id && (
                          <ReferredBadge by={contactName(c.referred_by_contact_id)} />
                        )}
                        <HolidayOooBadge until={c.ooo_until} reason={c.ooo_reason} />
                        <ContactStatusBadge status={c.contact_status} />
                      </div>
                    </div>
                    {c.phone && (
                      <div className="mt-1 text-zinc-600">{c.phone}</div>
                    )}
                    {looksLikeRealEmail(c.email) ? (
                      <div className="mt-1 text-zinc-600">
                        <a
                          href={`mailto:${c.email}`}
                          className="text-blue-600 hover:underline"
                        >
                          {c.email}
                        </a>
                        {canResolve && (
                          <ContactRelookup
                            contactId={c.id}
                            providerName={resolverName}
                          />
                        )}
                      </div>
                    ) : (
                      <ContactEmail
                        contactId={c.id}
                        canResolve={canResolve}
                        providerName={resolverName}
                        website={lead.website}
                        lookupAttemptedAt={c.email_lookup_attempted_at ?? null}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!mergedInto && !inquiry && (
              <details className="mt-3 rounded-md border border-zinc-200 bg-white p-3 text-sm">
                <summary className="cursor-pointer font-medium text-zinc-700">
                  Add referred contact
                </summary>
                <p className="mb-3 mt-2 text-xs text-zinc-500">
                  Someone here pointed you to a colleague? Add that person to
                  this lead so the organization keeps its attribution. Use this
                  instead of creating a new lead.
                </p>
                <AddReferredContact
                  leadId={lead.id}
                  contacts={lead.contacts.map((c) => ({
                    id: c.id,
                    name: c.name,
                    email: c.email,
                  }))}
                />
              </details>
            )}
          </section>

          {/* Outreach */}
          <section>
            <h2 className="mb-2 text-sm font-medium text-zinc-500">Outreach</h2>
            {inquiry ? (
              <p className="text-sm text-zinc-500">
                {NON_BOOKING_NOTE} No outreach is drafted or sent from here.
              </p>
            ) : (
              <OutreachManager
                leadId={lead.id}
                contacts={lead.contacts}
                outreach={lead.outreach}
                guard={guard}
              />
            )}
          </section>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <section className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-medium text-zinc-500">Status</h2>
            <StatusControl
              leadId={lead.id}
              current={lead.status}
              currentRevisitOn={lead.revisit_on ?? null}
              currentRevisitNote={lead.revisit_note ?? null}
            />
            <RevisitDateControl
              key={`${lead.revisit_on ?? ""}|${lead.revisit_note ?? ""}`}
              leadId={lead.id}
              current={lead.revisit_on ?? null}
              currentNote={lead.revisit_note ?? null}
            />
          </section>

          {/* Automated follow-ups (never for non-booking inquiries) */}
          {!inquiry && (
            <section className="rounded-lg border border-zinc-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-medium text-zinc-500">
                Follow-ups
              </h2>
              <FollowupsPanel sequences={followups} contacts={lead.contacts} />
            </section>
          )}

          {/* Bookings */}
          {(lead.status === "booked" || lead.bookings.length > 0) && (
            <section className="rounded-lg border border-zinc-200 bg-white p-4">
              <h2 className="mb-2 text-sm font-medium text-zinc-500">
                Bookings
              </h2>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span>Commission attribution:</span>
                {origin.via ? (
                  <OriginBadge
                    via={origin.via}
                    overridden={origin.overridden}
                    reason={origin.reason}
                  />
                ) : (
                  <span>nothing sent yet</span>
                )}
              </div>
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

      {/* Advanced: merge, attribution override, attribution history. Collapsed
          so none of it is triggered by accident. */}
      <details className="rounded-lg border border-zinc-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-zinc-600">
          Advanced: lead kind, merge, attribution
        </summary>
        <div className="mt-4">
          <LeadAdvancedPanel
            leadId={lead.id}
            leadName={lead.name}
            origin={origin}
            merged={Boolean(mergedInto)}
            kind={lead.kind}
            inquiryType={lead.inquiry_type ?? null}
            history={attributionHistory.map((h) => ({
              id: h.id,
              detail: h.detail,
              created_at: h.created_at,
            }))}
          />
        </div>
      </details>
    </div>
  );
}
