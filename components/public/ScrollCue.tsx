"use client";

import { motion, useReducedMotion } from "motion/react";

/** Subtle "scroll" hint at the bottom of the hero. */
export function ScrollCue() {
  const reduced = useReducedMotion();

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-7 flex justify-center">
      <motion.div
        className="flex flex-col items-center gap-1 text-white/55"
        animate={reduced ? undefined : { y: [0, 8, 0] }}
        transition={
          reduced ? undefined : { duration: 1.8, repeat: Infinity, ease: "easeInOut" }
        }
      >
        <span className="text-[10px] uppercase tracking-[0.3em]">Scroll</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </motion.div>
    </div>
  );
}
