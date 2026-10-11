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
  OutreachChannel,
  OutreachStatus,
} from "@/lib/types";

function Pill({
  children,
  className,
}: {
  children: React.ReactNode;
  className: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: LeadStatus }) {
  return <Pill className={statusClasses(status)}>{statusLabel(status)}</Pill>;
}

export function ContactStatusBadge({ status }: { status: ContactStatus }) {
  return (
    <Pill className={contactStatusClasses(status)}>
      {contactStatusLabel(status)}
    </Pill>
  );
}

export function OutreachStatusBadge({ status }: { status: OutreachStatus }) {
  const label = { draft: "Draft", queued: "Queued", sent: "Sent", failed: "Failed" }[status];
  return <Pill className={outreachStatusClasses(status)}>{label}</Pill>;
}

export function originLabel(via: OutreachChannel): string {
  return via === "app" ? "Sent via app" : "Sent from Gmail";
}

/**
 * Who started the conversation with this lead. "Sent via app" means the
 * operator sent the first outreach here (commissionable); "Sent from Gmail"
 * means it was sent by hand and imported. Renders nothing until something has
 * been sent.
 */
export function OriginBadge({ via }: { via: OutreachChannel | null }) {
  if (!via) return null;
  return (
    <Pill
      className={
        via === "app"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-amber-200 bg-amber-50 text-amber-800"
      }
    >
      {originLabel(via)}
    </Pill>
  );
}

/**
 * Marks leads that arrived through the jeffflake.com booking form. Renders
 * nothing for outbound (discovered) leads to keep the common case uncluttered.
 */
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
}: {
  contactsCount: number;
  hasContactEmail: boolean;
}) {
  if (hasContactEmail) return null;
  return (
    <Pill className="border-amber-200 bg-amber-50 text-amber-700">
      {contactsCount === 0 ? "No contact" : "No email"}
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

export function TypeBadge({ type }: { type: string }) {
  return (
    <Pill className="border-zinc-200 bg-zinc-50 text-zinc-600">{type}</Pill>
  );
}
