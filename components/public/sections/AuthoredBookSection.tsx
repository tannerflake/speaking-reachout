import { SiteImage } from "@/components/public/SiteImage";
import { Reveal } from "@/components/public/Reveal";
import type { AuthoredBookData, SiteImageRow } from "@/lib/site/types";

export function AuthoredBookSection({
  data,
  images,
}: {
  data: AuthoredBookData | null;
  images: Record<string, SiteImageRow>;
}) {
  if (!data) return null;

  const imageKey = data.image_key ?? "book_cover_conscience";

  return (
    <section
      id="the-book"
      className="scroll-mt-20 bg-paper py-20 sm:py-28"
    >
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 sm:px-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-16">
        {/* Cover */}
        <Reveal direction="right">
          <div className="mx-auto w-full max-w-xs lg:max-w-sm">
            {data.url ? (
              <a
                href={data.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={data.title ? `${data.title} — see more` : "See more"}
                className="block transition-transform duration-300 hover:-translate-y-1"
              >
                <SiteImage
                  image={images[imageKey]}
                  imageKey={imageKey}
                  aspect="aspect-[2/3]"
                  className="border border-rule shadow-xl shadow-oxford/10"
                  sizes="(max-width: 1024px) 80vw, 33vw"
                />
              </a>
            ) : (
              <SiteImage
                image={images[imageKey]}
                imageKey={imageKey}
                aspect="aspect-[2/3]"
                className="border border-rule shadow-xl shadow-oxford/10"
                sizes="(max-width: 1024px) 80vw, 33vw"
              />
            )}
          </div>
        </Reveal>

        {/* Copy */}
        <Reveal direction="left" delay={0.1}>
          <div>
            {data.eyebrow && <p className="eyebrow">{data.eyebrow}</p>}
            {data.badge && (
              <div className="mt-4">
                <span className="inline-flex items-center border border-brass/40 bg-brass/[0.06] px-3 py-1 text-xs font-semibold uppercase tracking-widest text-brass">
                  {data.badge}
                </span>
              </div>
            )}
            {data.title && (
              <h2 className="mt-4 font-display text-4xl font-medium leading-tight text-oxford sm:text-5xl">
                {data.title}
              </h2>
            )}
            {data.subtitle && (
              <p className="mt-3 font-display text-xl italic text-graphite/70">
                {data.subtitle}
              </p>
            )}
            {data.body && (
              <p className="mt-6 text-lg leading-relaxed text-graphite/85">
                {data.body}
              </p>
            )}
            {data.quote && (
              <blockquote className="mt-6 border-l-2 border-brass pl-5 text-base leading-relaxed text-graphite/80">
                &ldquo;{data.quote}&rdquo;
                {data.quote_attribution && (
                  <cite className="mt-2 block text-sm not-italic text-slate">
                    &mdash; {data.quote_attribution}
                  </cite>
                )}
              </blockquote>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
              {data.url && (
                <a
                  href={data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-md bg-oxford px-7 py-3.5 text-base font-semibold tracking-wide text-white transition-colors hover:bg-oxford-soft"
                >
                  {data.cta_label ?? "See more"}
                  <span aria-hidden>&rarr;</span>
                </a>
              )}
              {data.meta && (
                <span className="text-sm text-slate">{data.meta}</span>
              )}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
