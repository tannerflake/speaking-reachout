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
    <footer className="bg-oxford text-white">
      {/* Thin brass rule as a restrained ornamental cap. */}
      <div className="h-px w-full bg-brass/50" />
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-12 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <Link href="/" aria-label="Jeff Flake home" className="text-white">
          <SignatureLogo image={signature} height={54} />
        </Link>
        <nav className="flex flex-wrap gap-x-7 gap-y-2">
          {QUICK_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm tracking-wide text-white/70 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <a
          href={`mailto:${email}`}
          className="text-sm tracking-wide text-white/70 transition-colors hover:text-white"
        >
          {email}
        </a>
      </div>
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 pb-8 sm:px-8">
        <p className="text-xs tracking-wide text-white/45">
          &copy; Jeff Flake {year}.
        </p>
        {/* Discreet back door to the admin area, in line with the copyright. */}
        <Link
          href="/admin"
          className="text-xs text-white/15 transition-colors hover:text-white/40"
        >
          admin
        </Link>
      </div>
    </footer>
  );
}
