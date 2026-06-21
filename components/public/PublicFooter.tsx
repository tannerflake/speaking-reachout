import Link from "next/link";
import { SignatureLogo } from "@/components/public/SignatureLogo";
import type { SiteImageRow } from "@/lib/site/types";

const QUICK_LINKS = [
  { href: "/#story", label: "Story" },
  { href: "/#speaking", label: "Speaking" },
  { href: "/#media", label: "Media" },
  { href: "/#book", label: "Book" },
];

export function PublicFooter({
  signature,
  email = "cheryl@jeffflake.com",
}: {
  signature: SiteImageRow | undefined;
  email?: string;
}) {
  // Computed dynamically so the copyright year never goes stale.
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-white/10 bg-navy-950">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-12 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <Link href="/" aria-label="Jeff Flake home">
          <SignatureLogo image={signature} height={44} />
        </Link>
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          {QUICK_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-white/65 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-col gap-1 sm:items-end">
          <a
            href={`mailto:${email}`}
            className="text-sm text-white/65 transition-colors hover:text-white"
          >
            {email}
          </a>
          {/* Discreet back door to the admin area. */}
          <Link
            href="/admin"
            className="text-xs text-white/15 transition-colors hover:text-white/40"
          >
            admin
          </Link>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-5 pb-8 sm:px-8">
        <p className="text-xs text-white/40">&copy; Jeff Flake {year}.</p>
      </div>
    </footer>
  );
}
