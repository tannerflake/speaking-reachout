import { Reveal } from "@/components/public/Reveal";
import type { MediaItemData } from "@/lib/site/types";

export function MediaSection({ items }: { items: MediaItemData[] }) {
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
            const Card = (
              <>
                {item.outlet && (
                  <span className="text-xs font-semibold uppercase tracking-widest text-brass">
                    {item.outlet}
                  </span>
                )}
                <h3 className="mt-2 font-display text-xl font-medium leading-snug text-oxford">
                  {item.title}
                </h3>
                {item.url && (
                  <span className="mt-4 inline-flex items-center gap-1 text-sm text-slate transition-colors group-hover:text-oxford">
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
                    className="group flex h-full flex-col border border-rule bg-panel p-6 transition-colors hover:border-brass/50"
                  >
                    {Card}
                  </a>
                ) : (
                  <div className="flex h-full flex-col border border-rule bg-panel p-6">
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
