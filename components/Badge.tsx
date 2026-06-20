import {
  contactStatusClasses,
  contactStatusLabel,
  outreachStatusClasses,
  statusClasses,
  statusLabel,
} from "@/lib/utils";
import type { ContactStatus, LeadStatus, OutreachStatus } from "@/lib/types";

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
  const label = { draft: "Draft", sent: "Sent", failed: "Failed" }[status];
  return <Pill className={outreachStatusClasses(status)}>{label}</Pill>;
}

export function TypeBadge({ type }: { type: string }) {
  return (
    <Pill className="border-zinc-200 bg-zinc-50 text-zinc-600">{type}</Pill>
  );
}
