import { SiteImage } from "@/components/public/SiteImage";
import { Reveal } from "@/components/public/Reveal";
import { StatCountUp } from "@/components/public/StatCountUp";
import type { SiteImageRow, StoryData } from "@/lib/site/types";

export function StorySection({
  story,
  images,
}: {
  story: StoryData[];
  images: Record<string, SiteImageRow>;
}) {
  if (story.length === 0) return null;

  return (
    <section id="story" className="scroll-mt-20 bg-navy-950 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <p className="mb-16 text-center text-sm font-medium uppercase tracking-[0.25em] text-accent-bright">
            The story
          </p>
        </Reveal>

        <div className="space-y-24 sm:space-y-36">
          {story.map((beat, i) => {
            const warm = beat.tone === "warm";
            const imageKey = beat.image_key ?? `story_${i}`;
            const flip = i % 2 === 1;

            return (
              <div
                key={`${beat.title}-${i}`}
                className={`grid items-center gap-8 sm:grid-cols-2 sm:gap-14 ${
                  warm ? "rounded-3xl bg-warm-deep/15 p-6 sm:p-10" : ""
                }`}
              >
                <Reveal
                  direction={flip ? "left" : "right"}
                  className={flip ? "sm:order-2" : ""}
                >
                  <SiteImage
                    image={images[imageKey]}
                    imageKey={imageKey}
                    aspect="aspect-[4/5]"
                    className={`rounded-2xl ${
                      warm ? "ring-1 ring-warm/40" : "ring-1 ring-white/10"
                    }`}
                    sizes="(max-width: 640px) 100vw, 50vw"
                  />
                </Reveal>

                <Reveal direction={flip ? "right" : "left"} delay={0.1}>
                  <div>
                    <span
                      className={`text-xs font-semibold uppercase tracking-[0.2em] ${
                        warm ? "text-warm" : "text-accent-bright"
                      }`}
                    >
                      Chapter {i + 1}
                    </span>
                    <h2 className="mt-3 font-display text-3xl font-semibold leading-tight text-white sm:text-4xl">
                      {beat.title}
                    </h2>
                    <p className="mt-5 text-lg leading-relaxed text-white/75">
                      {beat.body}
                    </p>

                    {beat.stats && beat.stats.length > 0 && (
                      <div className="mt-8 flex gap-10">
                        {beat.stats.map((s) => (
                          <StatCountUp
                            key={s.label}
                            value={s.value}
                            label={s.label}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </Reveal>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
