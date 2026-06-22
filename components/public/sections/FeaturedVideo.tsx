import { Reveal } from "@/components/public/Reveal";
import { VideoEmbed } from "@/components/public/VideoEmbed";
import { imagePublicUrl } from "@/lib/site/images";
import type { FeaturedVideoData, SiteImageRow } from "@/lib/site/types";

export function FeaturedVideo({
  videos,
  images,
}: {
  videos: FeaturedVideoData[];
  images: Record<string, SiteImageRow>;
}) {
  if (videos.length === 0) return null;

  // The section heading comes from the first video; later videos render as
  // additional cards stacked beneath it.
  const heading = videos[0].title ?? "Watch Jeff in Action";

  return (
    <section className="bg-paper py-20 sm:py-28">
      <div className="mx-auto max-w-4xl px-5 sm:px-8">
        <Reveal>
          <h2 className="font-display text-3xl font-medium text-oxford sm:text-4xl">
            {heading}
          </h2>
        </Reveal>
        <div className="mt-8 space-y-14">
          {videos.map((video, i) => {
            const posterKey = video.poster_image_key ?? "";
            const poster = posterKey ? images[posterKey] : undefined;
            return (
              <Reveal key={`${video.video_url ?? video.title ?? i}`} delay={0.1}>
                {video.caption && (
                  <p className="mb-4 max-w-2xl text-lg leading-relaxed text-graphite/80">
                    {video.caption}
                  </p>
                )}
                <VideoEmbed
                  videoUrl={video.video_url ?? ""}
                  posterUrl={imagePublicUrl(poster)}
                  posterKey={posterKey}
                  posterSubject={poster?.subject ?? null}
                  caption={video.caption}
                />
                {video.event_url && (
                  <a
                    href={video.event_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-block text-sm font-medium text-brass underline-offset-4 hover:underline"
                  >
                    View the event details
                  </a>
                )}
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
