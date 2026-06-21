"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { TopicData } from "@/lib/site/types";

/** Click-to-expand topic cards with a smooth height/opacity animation. */
export function TopicAccordion({ topics }: { topics: TopicData[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const reduced = useReducedMotion();

  return (
    <div className="divide-y divide-white/10 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
      {topics.map((topic, i) => {
        const isOpen = open === i;
        return (
          <div key={`${topic.title}-${i}`}>
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 px-5 py-5 text-left transition-colors hover:bg-white/[0.03] sm:px-7"
            >
              <span className="font-display text-xl font-medium text-white sm:text-2xl">
                {topic.title}
              </span>
              <motion.span
                aria-hidden
                animate={{ rotate: isOpen ? 45 : 0 }}
                transition={{ duration: reduced ? 0 : 0.25 }}
                className="shrink-0 text-2xl font-light leading-none text-accent-bright"
              >
                +
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {isOpen && topic.body && (
                <motion.div
                  initial={reduced ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduced ? undefined : { height: 0, opacity: 0 }}
                  transition={{ duration: reduced ? 0 : 0.3, ease: "easeInOut" }}
                  className="overflow-hidden"
                >
                  <p className="px-5 pb-6 text-base leading-relaxed text-white/70 sm:px-7">
                    {topic.body}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
