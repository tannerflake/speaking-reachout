import Link from "next/link";
import { Reveal } from "@/components/public/Reveal";
import { TopicAccordion } from "@/components/public/TopicAccordion";
import type { EngagementData, TopicData } from "@/lib/site/types";

export function SpeakingSection({
  topics,
  audienceTypes,
  engagements,
}: {
  topics: TopicData[];
  audienceTypes: string[];
  engagements: EngagementData[];
}) {
  const recent = engagements.filter((e) => e.kind !== "upcoming");
  const upcoming = engagements.filter((e) => e.kind === "upcoming");

  return (
    <section
      id="speaking"
      className="scroll-mt-20 border-t border-white/10 bg-navy-900 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <p className="text-sm font-medium uppercase tracking-[0.25em] text-accent-bright">
            Speaking
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-4xl font-semibold leading-tight text-white sm:text-5xl">
            A voice that challenges without polarizing.
          </h2>
        </Reveal>

        {/* Topics */}
        {topics.length > 0 && (
          <div className="mt-12">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-white/45">
              Frequent topics
            </h3>
            <Reveal>
              <TopicAccordion topics={topics} />
            </Reveal>
          </div>
        )}

        {/* Audience types */}
        {audienceTypes.length > 0 && (
          <div className="mt-16">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-white/45">
              Formats &amp; audiences
            </h3>
            <div className="flex flex-wrap gap-3">
              {audienceTypes.map((a, i) => (
                <Reveal as="span" key={a} delay={i * 0.04} direction="up">
                  <span className="inline-flex rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-white/85">
                    {a}
                  </span>
                </Reveal>
              ))}
            </div>
          </div>
        )}

        {/* Engagements */}
        {(recent.length > 0 || upcoming.length > 0) && (
          <div className="mt-16 grid gap-10 sm:grid-cols-2">
            {recent.length > 0 && (
              <Reveal>
                <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-white/45">
                  Recent engagements
                </h3>
                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {recent.map((e) => (
                    <li
                      key={e.name}
                      className="rounded-lg border border-white/8 bg-white/[0.02] px-4 py-3 text-sm text-white/80"
                    >
                      {e.name}
                    </li>
                  ))}
                </ul>
              </Reveal>
            )}
            {upcoming.length > 0 && (
              <Reveal delay={0.1}>
                <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-white/45">
                  Upcoming
                </h3>
                <ul className="space-y-2">
                  {upcoming.map((e) => (
                    <li
                      key={e.name}
                      className="flex items-center gap-3 rounded-lg border border-accent/25 bg-accent/[0.06] px-4 py-3 text-sm text-white/90"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-accent-bright" />
                      {e.name}
                    </li>
                  ))}
                </ul>
              </Reveal>
            )}
          </div>
        )}

        <Reveal>
          <div className="mt-16">
            <Link
              href="/#book"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-7 py-3.5 text-base font-semibold text-white transition-colors hover:bg-accent-bright"
            >
              Bring Jeff to your stage
              <span aria-hidden>&rarr;</span>
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
