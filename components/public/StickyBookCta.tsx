"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const DEFAULT_HIDE_IDS = ["book", "inquiries", "site-footer"];

/**
 * Mobile-only sticky "Book Jeff" bar. On desktop the fixed header's
 * "Book Jeff" link already plays this role, so this renders nothing visible
 * at sm and up.
 *
 * Shows once `triggerId` has scrolled out of view above the viewport, and
 * hides whenever any `hideWhenVisibleIds` element (booking form, inquiries,
 * footer) is on screen so it never covers the form or the page bottom.
 */
export function StickyBookCta({
  label = "Book Jeff as a Speaker",
  triggerId,
  hideWhenVisibleIds = DEFAULT_HIDE_IDS,
}: {
  label?: string;
  triggerId?: string;
  hideWhenVisibleIds?: string[];
}) {
  const [pastTrigger, setPastTrigger] = useState(false);
  const [hideTargetVisible, setHideTargetVisible] = useState(false);
  const hideKey = hideWhenVisibleIds.join("|");

  // Trigger: visible once the trigger element is fully above the viewport.
  useEffect(() => {
    const trigger = triggerId ? document.getElementById(triggerId) : null;

    if (!trigger) {
      const onScroll = () => setPastTrigger(window.scrollY > 400);
      onScroll();
      window.addEventListener("scroll", onScroll, { passive: true });
      return () => window.removeEventListener("scroll", onScroll);
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        setPastTrigger(
          !entry.isIntersecting && entry.boundingClientRect.bottom < 0,
        );
      }
    });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [triggerId]);

  // Hide targets: hidden while any of them intersects the viewport.
  useEffect(() => {
    const targets = hideKey
      .split("|")
      .map((id) => (id ? document.getElementById(id) : null))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;

    const visible = new Set<Element>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      setHideTargetVisible(visible.size > 0);
    });
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [hideKey]);

  const show = pastTrigger && !hideTargetVisible;

  return (
    <div
      aria-hidden={show ? undefined : true}
      className={`fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-oxford/95 px-5 pt-3 backdrop-blur transition-all duration-300 ease-out motion-reduce:transition-none sm:hidden ${
        show
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-full opacity-0"
      }`}
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      <Link
        href="/#book"
        tabIndex={show ? undefined : -1}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-brass-soft px-6 py-3 text-base font-semibold tracking-wide text-oxford transition-colors hover:bg-white"
      >
        {label}
        <span aria-hidden>&rarr;</span>
      </Link>
    </div>
  );
}
