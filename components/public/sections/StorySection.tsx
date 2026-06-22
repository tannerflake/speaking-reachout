import { SiteImage } from "@/components/public/SiteImage";
import { StoryVideoImage } from "@/components/public/StoryVideoImage";
import { Reveal } from "@/components/public/Reveal";
import { VideoEmbed } from "@/components/public/VideoEmbed";
import { imagePublicUrl } from "@/lib/site/images";
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
    <section id="story" className="scroll-mt-20 bg-paper py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <div className="mb-16 flex items-center justify-center gap-4">
            <span className="h-px w-10 bg-brass/60" />
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-brass">
              Jeff&rsquo;s story
            </p>
            <span className="h-px w-10 bg-brass/60" />
          </div>
        </Reveal>

        <div className="space-y-24 sm:space-y-32">
          {story.map((beat, i) => {
            const warm = beat.tone === "warm";
            const imageKey = beat.image_key ?? `story_${i}`;
            const flip = i % 2 === 1;
            const gallery = beat.gallery ?? [];
            const hasMedia = Boolean(beat.video_url) || gallery.length > 0;

            return (
              <div
                key={`${beat.title}-${i}`}
                className={
                  warm
                    ? "border border-rule border-l-2 border-l-brass bg-paper-2 p-6 sm:p-10"
                    : ""
                }
              >
                <div className="grid items-center gap-8 sm:grid-cols-2 sm:gap-14">
                  <Reveal
                    direction={flip ? "left" : "right"}
                    className={flip ? "sm:order-2" : ""}
                  >
                    {beat.modal_video_url ? (
                      <StoryVideoImage
                        image={images[imageKey]}
                        imageKey={imageKey}
                        videoUrl={beat.modal_video_url}
                        title={beat.title}
                        aspect="aspect-[4/5]"
                        aspectRatio={beat.image_aspect}
                        className={`border ${warm ? "border-brass/40" : "border-rule"}`}
                        objectPosition={beat.image_position}
                        sizes="(max-width: 640px) 100vw, 50vw"
                      />
                    ) : (
                      <SiteImage
                        image={images[imageKey]}
                        imageKey={imageKey}
                        aspect="aspect-[4/5]"
                        aspectRatio={beat.image_aspect}
                        className={`border ${warm ? "border-brass/40" : "border-rule"}`}
                        objectPosition={beat.image_position}
                        sizes="(max-width: 640px) 100vw, 50vw"
                      />
                    )}
                  </Reveal>

                  <Reveal direction={flip ? "right" : "left"} delay={0.1}>
                    <div>
                      <h2 className="font-display text-3xl font-medium leading-tight text-oxford sm:text-4xl">
                        {beat.title}
                      </h2>
                      <div
                        className={`mt-4 h-px w-12 ${warm ? "bg-brass" : "bg-rule"}`}
                      />
                      <p className="mt-6 text-lg leading-relaxed text-graphite/85">
                        {beat.body}
                      </p>
                    </div>
                  </Reveal>
                </div>

                {/* Richer chapter: gallery of additional photos + embedded video. */}
                {hasMedia && (
                  <Reveal delay={0.15}>
                    <div className="mt-8 space-y-5 sm:mt-10 sm:space-y-6">
                      {gallery.length > 0 && (
                        <div
                          className={`grid gap-4 ${
                            gallery.length === 1
                              ? "grid-cols-1"
                              : "grid-cols-2 sm:grid-cols-3"
                          }`}
                        >
                          {gallery.map((key) => (
                            <SiteImage
                              key={key}
                              image={images[key]}
                              imageKey={key}
                              aspect="aspect-[4/3]"
                              className="border border-brass/30"
                              sizes="(max-width: 640px) 50vw, 33vw"
                            />
                          ))}
                        </div>
                      )}

                      {beat.video_url && (
                        <VideoEmbed
                          videoUrl={beat.video_url}
                          posterUrl={imagePublicUrl(images[imageKey])}
                          posterKey={imageKey}
                          posterSubject={images[imageKey]?.subject ?? null}
                          caption={beat.title}
                        />
                      )}
                    </div>
                  </Reveal>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
