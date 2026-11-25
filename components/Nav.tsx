"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/auth/profile";

const CRM_LINKS = [
  { href: "/admin", label: "Dashboard", exact: true },
  { href: "/admin/leads", label: "Leads" },
  { href: "/admin/inquiries", label: "Inquiries", badge: "inquiries" as const },
  { href: "/admin/discover", label: "Discover" },
  { href: "/admin/voice-insights", label: "Voice & Insights" },
  { href: "/admin/settings/tailoring", label: "Tailoring" },
  { href: "/admin/settings/bot-access", label: "Bot access" },
  { href: "/admin/site-editor", label: "Site editor" },
];

// Editors (Jeff) only need the site editor.
const EDITOR_LINKS = [
  { href: "/admin/site-editor", label: "Site editor", exact: true },
];

export function Nav({
  role = "crm_admin",
  newInquiries = 0,
}: {
  role?: UserRole;
  /** Inquiry leads still at status New (count badge on Inquiries). */
  newInquiries?: number;
}) {
  const pathname = usePathname();
  const links = role === "editor" ? EDITOR_LINKS : CRM_LINKS;
  return (
    <nav className="flex items-center gap-1">
      {links.map((l) => {
        const active = l.exact
          ? pathname === l.href
          : pathname === l.href || pathname.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-zinc-900 text-white"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
            )}
          >
            {l.label}
            {"badge" in l && l.badge === "inquiries" && newInquiries > 0 && (
              <span
                className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-fuchsia-600 px-1.5 text-[11px] font-semibold text-white"
                title={`${newInquiries} new inquir${newInquiries === 1 ? "y" : "ies"}`}
              >
                {newInquiries}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
