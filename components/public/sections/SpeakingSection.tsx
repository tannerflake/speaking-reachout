import Link from "next/link";
import { Reveal } from "@/components/public/Reveal";
import { TopicAccordion } from "@/components/public/TopicAccordion";
import { imagePublicUrl } from "@/lib/site/images";
import type {
  EngagementData,
  SiteImageRow,
  SpeakingData,
  TopicData,
} from "@/lib/site/types";

/** Image key for an engagement: an explicit override, else a slug of the name
 * (e.g. "Rutgers University" -> "rutgers_university"). Kept in sync with the
 * seeded image slots so an uploaded logo lands on the matching card. */
function engagementImageKey(e: EngagementData): string {
  if (e.image_key) return e.image_key;
  return (e.name ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function SpeakingSection({
  data,
  topics,
  audienceTypes,
  engagements,
  images,
}: {
  data: SpeakingData;
  topics: TopicData[];
  audienceTypes: string[];
  engagements: EngagementData[];
  images: Record<string, SiteImageRow>;
}) {
  return (
    <section
      id="speaking"
      className="scroll-mt-20 border-t border-rule bg-paper-2 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <p className="eyebrow">{data.eyebrow ?? "Speaking"}</p>
          <h2 className="mt-4 max-w-2xl font-display text-4xl font-medium leading-tight text-oxford sm:text-5xl">
            {data.heading ?? "A voice that challenges without polarizing."}
          </h2>
        </Reveal>

        {/* Topics */}
        {topics.length > 0 && (
          <div className="mt-12">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-slate">
              {data.topics_label ?? "Popular topics"}
            </h3>
            <Reveal>
              <TopicAccordion topics={topics} />
            </Reveal>
          </div>
        )}

        {/* Audience types */}
        {audienceTypes.length > 0 && (
          <div className="mt-16">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-slate">
              {data.audiences_label ?? "Formats & audiences"}
            </h3>
            <div className="flex flex-wrap gap-3">
              {audienceTypes.map((a, i) => (
                <Reveal as="span" key={a} delay={i * 0.04} direction="up">
                  <span className="inline-flex border border-rule bg-panel px-4 py-2.5 text-sm font-medium text-graphite">
                    {a}
                  </span>
                </Reveal>
              ))}
            </div>
          </div>
        )}

        {/* Engagements */}
        {engagements.length > 0 && (
          <div className="mt-16">
            <Reveal>
              <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-slate">
                {data.engagements_label ?? "Recent & upcoming engagements"}
              </h3>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {engagements.map((e) => {
                  const logoUrl = imagePublicUrl(images[engagementImageKey(e)]);
                  return (
                    <li
                      key={e.name}
                      className="group relative flex min-h-[3.5rem] items-center overflow-hidden border border-rule bg-panel px-4 py-3 text-sm text-graphite"
                    >
                      {logoUrl && (
                        <>
                          {/* Faint institution logo, bottom-right. Decorative. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={logoUrl}
                            alt=""
                            aria-hidden
                            className="pointer-events-none absolute -bottom-3 -right-3 h-14 w-auto max-w-[45%] object-contain object-right-bottom opacity-[0.09] transition-opacity duration-500 group-hover:opacity-[0.16]"
                          />
                          {/* Stylized sheen toward the logo corner. */}
                          <div className="pointer-events-none absolute inset-0 bg-gradient-to-tl from-oxford/[0.06] via-transparent to-transparent" />
                          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brass/[0.05] via-transparent to-transparent" />
                        </>
                      )}
                      <span className="relative z-10">{e.name}</span>
                    </li>
                  );
                })}
              </ul>
            </Reveal>
          </div>
        )}

        <Reveal>
          <div className="mt-16">
            <Link
              href="/#book"
              className="inline-flex items-center gap-2 rounded-md bg-oxford px-7 py-3.5 text-base font-semibold tracking-wide text-white transition-colors hover:bg-oxford-soft"
            >
              {data.cta_label ?? "Bring Jeff to your stage"}
              <span aria-hidden>&rarr;</span>
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
