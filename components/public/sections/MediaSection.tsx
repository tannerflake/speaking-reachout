import { Reveal } from "@/components/public/Reveal";
import type { MediaItemData } from "@/lib/site/types";

export function MediaSection({ items }: { items: MediaItemData[] }) {
  if (items.length === 0) return null;

  return (
    <section
      id="media"
      className="scroll-mt-20 border-t border-white/10 bg-navy-900 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <p className="text-sm font-medium uppercase tracking-[0.25em] text-accent-bright">
            In the media
          </p>
          <h2 className="mt-3 font-display text-4xl font-semibold text-white sm:text-5xl">
            Words on the record.
          </h2>
        </Reveal>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item, i) => {
            const Card = (
              <>
                {item.outlet && (
                  <span className="text-xs font-semibold uppercase tracking-widest text-accent-bright">
                    {item.outlet}
                  </span>
                )}
                <h3 className="mt-2 font-display text-xl font-medium leading-snug text-white">
                  {item.title}
                </h3>
                {item.url && (
                  <span className="mt-4 inline-flex items-center gap-1 text-sm text-white/55 transition-colors group-hover:text-white">
                    Read <span aria-hidden>&rarr;</span>
                  </span>
                )}
              </>
            );

            return (
              <Reveal key={`${item.title}-${i}`} delay={(i % 3) * 0.06}>
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-6 transition-colors hover:border-accent/40 hover:bg-white/[0.04]"
                  >
                    {Card}
                  </a>
                ) : (
                  <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-6">
                    {Card}
                  </div>
                )}
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
