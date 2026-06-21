import type {
  Contact,
  ContactStatus,
  LeadStatus,
  OutreachStatus,
} from "@/lib/types";

/** Join class names, dropping falsy values. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Extract a bare registrable-ish domain from a URL or domain string. */
export function domainFromUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Mirror the SQL name_normalized generated column for app-side dedup. */
export function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function statusLabel(status: LeadStatus): string {
  return {
    new: "New",
    reached_out: "Reached out",
    interested: "Interested",
    booked: "Booked",
    closed: "Closed",
    not_interested: "Not interested",
  }[status];
}

export function statusClasses(status: LeadStatus): string {
  return {
    new: "bg-zinc-100 text-zinc-700 border-zinc-200",
    reached_out: "bg-blue-50 text-blue-700 border-blue-200",
    interested: "bg-amber-50 text-amber-700 border-amber-200",
    booked: "bg-emerald-50 text-emerald-700 border-emerald-200",
    closed: "bg-violet-50 text-violet-700 border-violet-200",
    not_interested: "bg-rose-50 text-rose-700 border-rose-200",
  }[status];
}

export function contactStatusClasses(status: ContactStatus): string {
  return {
    verified: "bg-emerald-50 text-emerald-700 border-emerald-200",
    unverified: "bg-amber-50 text-amber-700 border-amber-200",
    needs_lookup: "bg-rose-50 text-rose-700 border-rose-200",
  }[status];
}

export function contactStatusLabel(status: ContactStatus): string {
  return {
    verified: "Verified",
    unverified: "Unverified",
    needs_lookup: "Needs lookup",
  }[status];
}

export function outreachStatusClasses(status: OutreachStatus): string {
  return {
    draft: "bg-zinc-100 text-zinc-700 border-zinc-200",
    sent: "bg-emerald-50 text-emerald-700 border-emerald-200",
    failed: "bg-rose-50 text-rose-700 border-rose-200",
  }[status];
}

/** Pick the best contact to address outreach to: verified+email, then any
 * email, then the first contact. */
export function pickPrimaryContact(contacts: Contact[]): Contact | null {
  if (!contacts || contacts.length === 0) return null;
  return (
    contacts.find((c) => c.email && c.contact_status === "verified") ??
    contacts.find((c) => c.email) ??
    contacts[0]
  );
}

/** Run an async fn over items with bounded concurrency, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/** Basic email shape check — used to reject obviously-fake provider output. */
export function looksLikeRealEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  // Reject placeholder patterns some providers return for locked emails.
  if (e.includes("not_unlocked") || e.includes("email_not")) return false;
  if (e.startsWith("noreply") || e.startsWith("no-reply")) return false;
  return true;
}
