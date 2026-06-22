import { Reveal } from "@/components/public/Reveal";
import { imagePublicUrl } from "@/lib/site/images";
import type { MediaItemData, SiteImageRow } from "@/lib/site/types";

export function MediaSection({
  items,
  images,
}: {
  items: MediaItemData[];
  images: Record<string, SiteImageRow>;
}) {
  if (items.length === 0) return null;

  return (
    <section
      id="media"
      className="scroll-mt-20 border-t border-rule bg-paper-2 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <p className="eyebrow">In the media</p>
          <h2 className="mt-4 font-display text-4xl font-medium text-oxford sm:text-5xl">
            Words on the record.
          </h2>
        </Reveal>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item, i) => {
            // Only render a logo when an asset is actually uploaded; otherwise
            // the card stays clean (no placeholder block).
            const logoUrl = item.image_key
              ? imagePublicUrl(images[item.image_key])
              : null;

            const Card = (
              <>
                {logoUrl && (
                  <>
                    {/* Faint outlet logo, bottom-right. Decorative only. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={logoUrl}
                      alt=""
                      aria-hidden
                      className="pointer-events-none absolute -bottom-5 -right-4 h-28 w-auto max-w-[62%] object-contain object-right-bottom opacity-[0.08] transition-opacity duration-500 group-hover:opacity-[0.14]"
                    />
                    {/* Stylized sheen toward the logo corner so it reads as designed. */}
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-tl from-oxford/[0.06] via-transparent to-transparent" />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brass/[0.05] via-transparent to-transparent" />
                  </>
                )}
                <div className="relative z-10 flex h-full flex-col">
                  {item.outlet && (
                    <span className="text-xs font-semibold uppercase tracking-widest text-brass">
                      {item.outlet}
                    </span>
                  )}
                  <h3 className="mt-2 font-display text-xl font-medium leading-snug text-oxford">
                    {item.title}
                  </h3>
                  {item.url && (
                    <span className="mt-auto inline-flex items-center gap-1 pt-5 text-sm text-slate transition-colors group-hover:text-oxford">
                      Read <span aria-hidden>&rarr;</span>
                    </span>
                  )}
                </div>
              </>
            );

            const cardClass =
              "group relative flex h-full flex-col overflow-hidden border border-rule bg-panel p-6";

            return (
              <Reveal key={`${item.title}-${i}`} delay={(i % 3) * 0.06}>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${cardClass} transition-colors hover:border-brass/50`}
                  >
                    {Card}
                  </a>
                ) : (
                  <div className={cardClass}>{Card}</div>
                )}
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
