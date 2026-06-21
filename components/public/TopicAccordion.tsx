"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { TopicData } from "@/lib/site/types";

/** Click-to-expand topic cards with a smooth height/opacity animation. */
export function TopicAccordion({ topics }: { topics: TopicData[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const reduced = useReducedMotion();

  return (
    <div className="divide-y divide-rule border border-rule bg-panel">
      {topics.map((topic, i) => {
        const isOpen = open === i;
        return (
          <div key={`${topic.title}-${i}`}>
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 px-5 py-5 text-left transition-colors hover:bg-paper-2 sm:px-7"
            >
              <span className="font-display text-xl font-medium text-oxford sm:text-2xl">
                {topic.title}
              </span>
              <motion.span
                aria-hidden
                animate={{ rotate: isOpen ? 45 : 0 }}
                transition={{ duration: reduced ? 0 : 0.25 }}
                className="shrink-0 text-2xl font-light leading-none text-brass"
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
                  <p className="px-5 pb-6 text-base leading-relaxed text-graphite/80 sm:px-7">
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
