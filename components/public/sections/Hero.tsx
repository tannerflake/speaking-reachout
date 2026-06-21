import Link from "next/link";
import { SiteImage } from "@/components/public/SiteImage";
import { Reveal } from "@/components/public/Reveal";
import { ScrollCue } from "@/components/public/ScrollCue";
import type { HeroData, SiteImageRow } from "@/lib/site/types";

export function Hero({
  data,
  images,
}: {
  data: HeroData;
  images: Record<string, SiteImageRow>;
}) {
  const imageKey = data.image_key ?? "hero_primary";

  return (
    <section className="relative flex min-h-screen items-end overflow-hidden">
      {/* Background image */}
      <div className="absolute inset-0">
        <SiteImage
          image={images[imageKey]}
          imageKey={imageKey}
          aspect="h-full w-full"
          // Mobile keeps the default centered cover (frames perfectly). On wider
          // desktop viewports a tall portrait would crop to its middle, so pull
          // the focal point toward the top to keep the face in frame.
          imgClassName="sm:object-top"
          priority
          sizes="100vw"
        />
        {/* Cinematic gradient for legible text over any photo. */}
        <div className="absolute inset-0 bg-gradient-to-t from-oxford via-oxford/60 to-oxford/25" />
      </div>

      <div className="relative mx-auto w-full max-w-6xl px-5 pb-28 pt-32 sm:px-8 sm:pb-32">
        <div className="max-w-3xl">
          {data.kicker && (
            <Reveal direction="up">
              <p className="mb-4 text-sm font-medium uppercase tracking-[0.25em] text-brass-soft">
                {data.kicker}
              </p>
            </Reveal>
          )}
          <Reveal direction="up" delay={0.05}>
            <h1 className="font-display text-5xl font-medium leading-[1.05] text-white sm:text-7xl">
              {data.headline ?? "Book Ambassador Jeff Flake."}
            </h1>
          </Reveal>
          {data.subhead && (
            <Reveal direction="up" delay={0.12}>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/85 sm:text-xl">
                {data.subhead}
              </p>
            </Reveal>
          )}
          <Reveal direction="up" delay={0.18}>
            <Link
              href="/#book"
              className="mt-9 inline-flex items-center gap-2 rounded-md bg-brass-soft px-7 py-3.5 text-base font-semibold tracking-wide text-oxford transition-colors hover:bg-white"
            >
              {data.cta_label ?? "Book Jeff as a Speaker"}
              <span aria-hidden>&rarr;</span>
            </Link>
          </Reveal>
        </div>
      </div>

      <ScrollCue />
    </section>
  );
}
