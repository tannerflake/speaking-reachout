import {
  contactStatusClasses,
  contactStatusLabel,
  outreachStatusClasses,
  statusClasses,
  statusLabel,
} from "@/lib/utils";
import type {
  ContactStatus,
  LeadSource,
  LeadStatus,
  OutreachStatus,
} from "@/lib/types";
import { localDatePlus, originValueLabel, type OriginValue } from "@/lib/attribution";
import { prettyDate } from "@/lib/followups/holiday";
import { inquiryBadge } from "@/lib/leads/kind";

function Pill({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status, title }: { status: LeadStatus; title?: string }) {
  return (
    <Pill className={statusClasses(status)} title={title}>
      {statusLabel(status)}
    </Pill>
  );
}

export function ContactStatusBadge({ status }: { status: ContactStatus }) {
  return (
    <Pill className={contactStatusClasses(status)}>
      {contactStatusLabel(status)}
    </Pill>
  );
}

export function OutreachStatusBadge({ status }: { status: OutreachStatus }) {
  const label = { draft: "Draft", queued: "Scheduled", sent: "Sent", failed: "Failed", blocked: "Blocked" }[status];
  return <Pill className={outreachStatusClasses(status)}>{label}</Pill>;
}

export function originLabel(via: OriginValue): string {
  return originValueLabel(via);
}

/**
 * Who started the conversation with this lead. "Sent via app" means the
 * operator sent the first outreach here (commissionable); "Sent from Gmail"
 * means it was sent by hand and imported; "Not via app" only comes from an
 * operator override. Renders nothing until something has been sent (or an
 * override is set). An override shows "(overridden)"; hover for the reason.
 */
export function OriginBadge({
  via,
  overridden = false,
  reason,
}: {
  via: OriginValue | null;
  overridden?: boolean;
  reason?: string | null;
}) {
  if (!via) return null;
  return (
    <Pill
      className={
        via === "app"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-amber-200 bg-amber-50 text-amber-800"
      }
      title={overridden ? `Attribution overridden: ${reason ?? "no reason recorded"}` : undefined}
    >
      {originLabel(via)}
      {overridden && <span className="ml-1 text-[10px] font-normal opacity-80">(overridden)</span>}
    </Pill>
  );
}

/**
 * "Revisit <date>" on a lead row: rose once the date has arrived, sky while
 * it is still ahead. Renders nothing without a date.
 */
export function RevisitBadge({ on, note }: { on: string | null | undefined; note?: string | null }) {
  if (!on) return null;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = on <= today;
  const label = new Date(`${on}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <Pill
      className={
        overdue
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-sky-200 bg-sky-50 text-sky-700"
      }
      title={`${overdue ? "Overdue: revisit was due" : "Revisit on"} ${on}${note ? `. ${note}` : ""}`}
    >
      Revisit {label}
      {overdue ? " (due)" : ""}
    </Pill>
  );
}

const HOLIDAY_PILL = "border-amber-200 bg-amber-50 text-amber-800";

/**
 * A contact whose holiday out-of-office paused their follow-ups. Shown while
 * ooo_until >= today; nothing is sent to them before that date.
 */
export function HolidayOooBadge({
  until,
  reason,
}: {
  until: string | null | undefined;
  reason?: string | null;
}) {
  if (!until || until < localDatePlus(0)) return null;
  return (
    <Pill
      className={HOLIDAY_PILL}
      title={`${reason ?? "Holiday out-of-office"}. No follow-ups to this contact before ${prettyDate(until)}.`}
    >
      Out for holidays (until {prettyDate(until)})
    </Pill>
  );
}

/** On a lead in the list: at least one contact is out for the holidays. */
export function LeadHolidayOooBadge({ until }: { until: string | null | undefined }) {
  if (!until) return null;
  return (
    <Pill
      className={HOLIDAY_PILL}
      title={`A contact here sent a holiday out-of-office; their follow-ups wait until ${prettyDate(until)}.`}
    >
      Out for holidays
    </Pill>
  );
}

/** Shown on a duplicate lead that was folded into another one. */
export function MergedBadge() {
  return <Pill className="border-zinc-300 bg-zinc-100 text-zinc-600">Merged</Pill>;
}

/** A contact someone at the org pointed us to; handled by hand. */
export function ReferredBadge({ by }: { by: string }) {
  return (
    <Pill
      className="border-violet-200 bg-violet-50 text-violet-700"
      title="Referred contact: never cold-emailed or followed up automatically"
    >
      Referred by {by}
    </Pill>
  );
}

/**
 * Marks leads that arrived through the jeffflake.com booking form. Renders
 * nothing for outbound (discovered) leads to keep the common case uncluttered.
 */
/** "Press inquiry" etc. on a non-booking inquiry lead; nothing otherwise. */
export function InquiryBadge({
  lead,
}: {
  lead: { kind?: string | null; inquiry_type?: string | null };
}) {
  const label = inquiryBadge(lead);
  if (!label) return null;
  return (
    <Pill
      className="border-fuchsia-200 bg-fuchsia-50 text-fuchsia-800"
      title="Non-booking inquiry. Reply manually from Cheryl's inbox."
    >
      {label}
    </Pill>
  );
}

export function SourceBadge({ source }: { source: LeadSource }) {
  if (source !== "website_inbound") return null;
  return (
    <Pill className="border-sky-200 bg-sky-50 text-sky-700">
      Via jeffflake.com
    </Pill>
  );
}

/**
 * Flags leads that can't be emailed yet: no contact at all, or contacts whose
 * emails are all missing/unusable. Renders nothing once a usable email exists.
 */
export function ContactGapBadge({
  contactsCount,
  hasContactEmail,
  exhausted = false,
}: {
  contactsCount: number;
  hasContactEmail: boolean;
  /** Every contact search came back without an email; nothing more to try. */
  exhausted?: boolean;
}) {
  if (hasContactEmail) return null;
  if (exhausted) {
    return (
      <Pill
        className="border-zinc-200 bg-zinc-50 text-zinc-500"
        title="Two rounds of contact search found nobody with a usable email. Bulk runs skip this lead; add an email by hand on the lead page."
      >
        No email found
      </Pill>
    );
  }
  return (
    <Pill className="border-amber-200 bg-amber-50 text-amber-700">
      {contactsCount === 0 ? "No contact" : "No email"}
    </Pill>
  );
}

/**
 * The engagement guard refuses this lead: the organization is already in a
 * conversation. Hover for the reason; the lead page has the override.
 */
export function BlockedBadge({ reason }: { reason: string }) {
  return (
    <Pill className="border-zinc-300 bg-zinc-100 text-zinc-700" title={reason}>
      Blocked
    </Pill>
  );
}

/**
 * Draft coverage for a lead's emailable contacts. Renders nothing when there
 * is no usable email (ContactGapBadge covers that case) or when every
 * emailable contact already has an email sent and nothing is left in draft.
 */
export function DraftGapBadge({
  emailableContacts,
  draftedContacts,
  hasUnsentDraft,
}: {
  emailableContacts: number;
  draftedContacts: number;
  hasUnsentDraft: boolean;
}) {
  if (emailableContacts === 0) return null;
  if (draftedContacts === 0) {
    return (
      <Pill className="border-rose-200 bg-rose-50 text-rose-700">No draft</Pill>
    );
  }
  if (draftedContacts < emailableContacts) {
    return (
      <Pill className="border-amber-200 bg-amber-50 text-amber-700">
        Partial drafts
      </Pill>
    );
  }
  if (!hasUnsentDraft) return null;
  return (
    <Pill className="border-emerald-200 bg-emerald-50 text-emerald-700">
      Drafted
    </Pill>
  );
}

/**
 * Shown next to a lead's name while any email to that lead is waiting in the
 * send queue, so it is obvious at a glance that they are already being sent
 * to. Renders nothing once the queue for that lead has drained.
 */
export function QueuedBadge({ count, nextAt }: { count: number; nextAt?: string | null }) {
  if (count <= 0) return null;
  const when = nextAt
    ? new Date(nextAt).toLocaleString([], {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  return (
    <Pill
      className="border-indigo-200 bg-indigo-50 text-indigo-700"
      title={`${count} email${count === 1 ? "" : "s"} scheduled in the send queue${when ? `; next ${when}` : ""}`}
    >
      {count === 1 ? "Scheduled" : `Scheduled (${count})`}
      {when ? ` · next ${when}` : ""}
    </Pill>
  );
}

/**
 * Drafts held back because the address was guessed or never confirmed.
 * Unverified addresses bounce about 1 in 4, so they don't go into the queue
 * until verified (configured verifier, Hunter "valid", or set by hand).
 */
export function NeedsVerificationBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Pill
      className="border-amber-200 bg-amber-50 text-amber-700"
      title={`${count} draft${count === 1 ? "" : "s"} held: the address needs verification before it can be sent`}
    >
      {count === 1 ? "Needs verification" : `Needs verification (${count})`}
    </Pill>
  );
}

/** Client-side work in flight on a lead (not persisted; lives in the page). */
export type WorkKind = "finding" | "drafting" | "preparing";

const WORK_LABELS: Record<WorkKind, { text: string; title: string }> = {
  finding: { text: "Finding contacts…", title: "Looking up contact emails for this lead" },
  drafting: { text: "Drafting…", title: "Writing outreach drafts for this lead" },
  preparing: { text: "Preparing…", title: "Finding contacts and drafting outreach for this lead" },
};

export function WorkingBadge({ kind }: { kind?: WorkKind }) {
  if (!kind) return null;
  const { text, title } = WORK_LABELS[kind];
  return (
    <Pill
      className="animate-pulse border-amber-200 bg-amber-50 text-amber-700"
      title={title}
    >
      {text}
    </Pill>
  );
}

export function TypeBadge({ type }: { type: string }) {
  return (
    <Pill className="border-zinc-200 bg-zinc-50 text-zinc-600">{type}</Pill>
  );
}
