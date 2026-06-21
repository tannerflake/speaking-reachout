import { Reveal } from "@/components/public/Reveal";
import { VideoEmbed } from "@/components/public/VideoEmbed";
import { imagePublicUrl } from "@/lib/site/images";
import type { FeaturedVideoData, SiteImageRow } from "@/lib/site/types";

export function FeaturedVideo({
  data,
  images,
}: {
  data: FeaturedVideoData | null;
  images: Record<string, SiteImageRow>;
}) {
  if (!data) return null;

  const posterKey = data.poster_image_key ?? "media_cuban_poster";
  const poster = images[posterKey];

  return (
    <section className="bg-paper py-20 sm:py-28">
      <div className="mx-auto max-w-4xl px-5 sm:px-8">
        <Reveal>
          <h2 className="font-display text-3xl font-medium text-oxford sm:text-4xl">
            {data.title ?? "Watch Jeff in Action"}
          </h2>
          {data.caption && (
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-graphite/80">
              {data.caption}
            </p>
          )}
        </Reveal>
        <Reveal delay={0.1}>
          <div className="mt-8">
            <VideoEmbed
              videoUrl={data.video_url ?? ""}
              posterUrl={imagePublicUrl(poster)}
              posterKey={posterKey}
              posterSubject={poster?.subject ?? null}
              caption={data.caption}
            />
          </div>
          {data.event_url && (
            <a
              href={data.event_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-block text-sm font-medium text-brass underline-offset-4 hover:underline"
            >
              View the event details
            </a>
          )}
        </Reveal>
      </div>
    </section>
  );
}
