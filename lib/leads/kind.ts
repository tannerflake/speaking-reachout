import type { SupabaseClient } from "@supabase/supabase-js";
import type { InquiryType, LeadKind } from "@/lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * Lead kinds (migration 0036). 'speaking' is every booking prospect, outbound
 * or inbound; 'inquiry' is a press / interview / other website inquiry that
 * must never enter outreach, enrichment, follow-ups or pipeline stats.
 */
export const INQUIRY_TYPES: InquiryType[] = ["press", "interview_student", "other"];

/** Badge text shown wherever an inquiry lead renders. */
export const INQUIRY_BADGE: Record<InquiryType, string> = {
  press: "Press inquiry",
  interview_student: "Interview/student inquiry",
  other: "Other inquiry",
};

/** Long label used in the public form and notification email. */
export const INQUIRY_TYPE_LABEL: Record<InquiryType, string> = {
  press: "Press / media",
  interview_student: "Interview or student request",
  other: "Other",
};

/** Short label used in the CRM note ("Website Press inquiry. ..."). */
export const INQUIRY_NOTE_LABEL: Record<InquiryType, string> = {
  press: "Press",
  interview_student: "Interview/student",
  other: "Other",
};

export const NON_BOOKING_NOTE =
  "Non-booking inquiry. Reply manually from Cheryl's inbox.";

/** Refusal message returned by every outreach path for an inquiry lead. */
export const INQUIRY_REFUSAL =
  "This is a non-booking inquiry: outreach, contact finding and follow-ups are off. Reply manually from Cheryl's inbox.";

export function isInquiryType(v: unknown): v is InquiryType {
  return typeof v === "string" && (INQUIRY_TYPES as string[]).includes(v);
}

/** True for a lead row (any shape) whose kind is 'inquiry'. */
export function isInquiryLead(lead: { kind?: LeadKind | string | null } | null | undefined): boolean {
  return lead?.kind === "inquiry";
}

export function inquiryBadge(lead: {
  kind?: LeadKind | string | null;
  inquiry_type?: InquiryType | string | null;
}): string | null {
  if (!isInquiryLead(lead)) return null;
  return isInquiryType(lead.inquiry_type)
    ? INQUIRY_BADGE[lead.inquiry_type]
    : INQUIRY_BADGE.other;
}

let _available = false;
let _checkedAt = 0;

/**
 * True once migration 0036 (leads.kind) is applied. A positive answer is
 * cached for the life of the process; a negative one is re-checked after a
 * minute so the filters switch on soon after the migration lands. Before it
 * lands no inquiry lead can exist, so skipping the filter is safe.
 */
export async function leadKindAvailable(db: Db): Promise<boolean> {
  if (_available) return true;
  if (Date.now() - _checkedAt < 60_000) return false;
  const { error } = await db.from("leads").select("kind").limit(1);
  _checkedAt = Date.now();
  _available = !error;
  return _available;
}

/** Restrict a leads query to speaking leads (no-op before migration 0036). */
export function speakingOnly<Q>(q: Q, available: boolean): Q {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return available ? (q as any).eq("kind", "speaking") : q;
}

/** Ids among `leadIds` that are inquiry leads (empty before migration 0036). */
export async function inquiryLeadIds(db: Db, leadIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (leadIds.length === 0 || !(await leadKindAvailable(db))) return out;
  const unique = Array.from(new Set(leadIds));
  for (let i = 0; i < unique.length; i += 200) {
    const { data } = await db
      .from("leads")
      .select("id")
      .in("id", unique.slice(i, i + 200))
      .eq("kind", "inquiry");
    for (const r of (data as Array<{ id: string }> | null) ?? []) out.add(r.id);
  }
  return out;
}
