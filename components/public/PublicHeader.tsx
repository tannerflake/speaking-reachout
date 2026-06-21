"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SignatureLogo } from "@/components/public/SignatureLogo";
import type { SiteImageRow } from "@/lib/site/types";

const NAV = [
  { href: "/#story", label: "Story" },
  { href: "/#speaking", label: "Speaking" },
  { href: "/#media", label: "Media" },
  { href: "/#book", label: "Book" },
];

export function PublicHeader({ signature }: { signature: SiteImageRow | undefined }) {
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        solid
          ? "border-b border-white/10 bg-navy-950/85 backdrop-blur"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
        <Link href="/" aria-label="Jeff Flake home" className="shrink-0">
          <SignatureLogo image={signature} height={30} />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          {NAV.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-full px-3 py-1.5 text-sm font-medium text-white/75 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/#book"
            className="ml-1 hidden rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent-bright sm:inline-block"
          >
            Book Jeff
          </Link>
        </nav>
      </div>
    </header>
  );
}
