"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SignatureLogo } from "@/components/public/SignatureLogo";
import type { SiteImageRow } from "@/lib/site/types";

const NAV = [
  { href: "/#story", label: "Story" },
  { href: "/#speaking", label: "Speaking" },
  { href: "/#media", label: "Media" },
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
      className={`fixed inset-x-0 top-0 z-50 text-white transition-colors duration-300 ${
        solid ? "border-b border-white/10 bg-oxford/95 backdrop-blur" : "bg-transparent"
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-2 sm:px-8">
        <Link href="/" aria-label="Jeff Flake home" className="shrink-0 text-white">
          <SignatureLogo image={signature} height={64} />
        </Link>
        <nav className="flex items-center gap-5 sm:gap-7">
          {NAV.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm font-medium tracking-wide text-white/80 transition-colors hover:text-white"
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/#book"
            className="ml-1 hidden rounded-md bg-brass-soft px-5 py-2 text-sm font-semibold tracking-wide text-oxford transition-colors hover:bg-white sm:inline-block"
          >
            Book Jeff
          </Link>
        </nav>
      </div>
    </header>
  );
}
