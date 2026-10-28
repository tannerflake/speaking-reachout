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

/**
 * Collapse a hostname to the domain an organization owns: "law.harvard.edu"
 * -> "harvard.edu", "cs.ox.ac.uk" -> "ox.ac.uk". Two leads or contacts that
 * share this are treated as the same organization by the engagement guard.
 */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.toLowerCase().trim().replace(/^www\./, "");
  if (!h || !h.includes(".")) return null;
  const parts = h.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tld = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  // Country-code second-level registries (edu.au, ac.uk, co.jp, ...).
  if (tld.length === 2 && SECOND_LEVEL.has(second)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

const SECOND_LEVEL = new Set(["edu", "ac", "co", "com", "org", "net", "gov", "or", "ne"]);

/** Personal mailbox providers: an address there says nothing about the org. */
export const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "comcast.net",
  "att.net",
  "verizon.net",
]);

/** Organization domain of an email address, or null for personal providers. */
export function orgDomainOfEmail(email: string | null | undefined): string | null {
  if (!email || !looksLikeRealEmail(email)) return null;
  const at = email.trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return null;
  const d = registrableDomain(email.trim().toLowerCase().slice(at + 1));
  if (!d || GENERIC_EMAIL_DOMAINS.has(d)) return null;
  return d;
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
    blocked: "Blocked",
    reached_out: "Reached out",
    followup_1: "Follow-up 1",
    followup_2: "Follow-up 2",
    followup_3: "Follow-up 3",
    interested: "Interested",
    booked: "Booked",
    closed: "Closed",
    closed_not_me: "Closed (Not Me)",
    not_interested: "Not interested",
    cant_pay: "Can't pay",
    junk: "Junk",
  }[status];
}

export function statusClasses(status: LeadStatus): string {
  return {
    new: "bg-zinc-100 text-zinc-700 border-zinc-200",
    blocked: "bg-zinc-200 text-zinc-700 border-zinc-300",
    reached_out: "bg-blue-50 text-blue-700 border-blue-200",
    followup_1: "bg-indigo-50 text-indigo-700 border-indigo-200",
    followup_2: "bg-indigo-50 text-indigo-700 border-indigo-200",
    followup_3: "bg-indigo-50 text-indigo-700 border-indigo-200",
    interested: "bg-amber-50 text-amber-700 border-amber-200",
    booked: "bg-emerald-50 text-emerald-700 border-emerald-200",
    closed: "bg-violet-50 text-violet-700 border-violet-200",
    closed_not_me: "bg-teal-50 text-teal-700 border-teal-200",
    not_interested: "bg-rose-50 text-rose-700 border-rose-200",
    cant_pay: "bg-orange-50 text-orange-700 border-orange-200",
    junk: "bg-stone-100 text-stone-500 border-stone-200",
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
    queued: "bg-indigo-50 text-indigo-700 border-indigo-200",
    sent: "bg-emerald-50 text-emerald-700 border-emerald-200",
    failed: "bg-rose-50 text-rose-700 border-rose-200",
    blocked: "bg-rose-100 text-rose-800 border-rose-300",
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
  // Scraped asset filenames ("jane-doe-150x150@2x.jpg") pass the shape test.
  // Saved as emails they also give the engagement guard a fake shared
  // "domain" (2x.jpg) that ties unrelated organizations together.
  if (FILE_EXTENSION_TLD.test(e) || /@\d+x\./.test(e)) return false;
  return true;
}

const FILE_EXTENSION_TLD =
  /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|pdf|css|js|json|html?|php|mp4|mov)$/;
