"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/auth/profile";

const CRM_LINKS = [
  { href: "/admin", label: "Dashboard", exact: true },
  { href: "/admin/leads", label: "Leads" },
  { href: "/admin/discover", label: "Discover" },
  { href: "/admin/voice-insights", label: "Voice & Insights" },
  { href: "/admin/settings/tailoring", label: "Tailoring" },
  { href: "/admin/site-editor", label: "Site editor" },
];

// Editors (Jeff) only need the site editor.
const EDITOR_LINKS = [
  { href: "/admin/site-editor", label: "Site editor", exact: true },
];

export function Nav({ role = "crm_admin" }: { role?: UserRole }) {
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
          </Link>
        );
      })}
    </nav>
  );
}
