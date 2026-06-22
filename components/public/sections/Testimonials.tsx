import { Reveal } from "@/components/public/Reveal";
import { imagePublicUrl } from "@/lib/site/images";
import type { SiteImageRow, TestimonialData } from "@/lib/site/types";

export function Testimonials({
  items,
  images,
}: {
  items: TestimonialData[];
  images: Record<string, SiteImageRow>;
}) {
  if (items.length === 0) return null;

  return (
    <section
      id="testimonials"
      className="scroll-mt-20 border-t border-rule bg-paper-2 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <p className="eyebrow">What audiences say</p>
        </Reveal>

        <div className="mt-12 columns-1 gap-5 sm:columns-2 lg:columns-3">
          {items.map((t, i) => {
            // Only render a logo when an asset is actually uploaded; otherwise
            // the card stays clean (no placeholder block).
            const logoUrl = t.image_key
              ? imagePublicUrl(images[t.image_key])
              : null;

            return (
              <Reveal key={`${t.attribution}-${i}`} delay={(i % 3) * 0.07}>
                <figure className="relative mb-5 break-inside-avoid overflow-hidden border border-rule bg-panel p-7">
                  {logoUrl && (
                    <>
                      {/* Faint brand logo, bottom-right. Decorative only. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={logoUrl}
                        alt=""
                        aria-hidden
                        className="pointer-events-none absolute -bottom-3 -right-3 h-24 w-auto max-w-[55%] object-contain object-right-bottom opacity-[0.07]"
                      />
                      {/* Soft sheen toward the logo corner so it reads as designed. */}
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-tl from-oxford/[0.04] via-transparent to-transparent" />
                    </>
                  )}
                  <div className="relative z-10">
                    <blockquote className="font-display text-lg leading-relaxed text-oxford">
                      &ldquo;{t.quote}&rdquo;
                    </blockquote>
                    {t.attribution && (
                      <figcaption className="mt-4 text-sm font-semibold uppercase tracking-wide text-brass">
                        {t.attribution}
                      </figcaption>
                    )}
                  </div>
                </figure>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
