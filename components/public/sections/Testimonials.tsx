import { Reveal } from "@/components/public/Reveal";
import type { TestimonialData } from "@/lib/site/types";

export function Testimonials({ items }: { items: TestimonialData[] }) {
  if (items.length === 0) return null;

  return (
    <section
      id="testimonials"
      className="scroll-mt-20 bg-navy-950 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <Reveal>
          <p className="text-sm font-medium uppercase tracking-[0.25em] text-accent-bright">
            What audiences say
          </p>
        </Reveal>

        <div className="mt-12 columns-1 gap-5 sm:columns-2 lg:columns-3">
          {items.map((t, i) => (
            <Reveal key={`${t.attribution}-${i}`} delay={(i % 3) * 0.07}>
              <figure className="mb-5 break-inside-avoid rounded-2xl border border-white/10 bg-white/[0.03] p-7">
                <blockquote className="font-display text-lg leading-relaxed text-white/90">
                  &ldquo;{t.quote}&rdquo;
                </blockquote>
                {t.attribution && (
                  <figcaption className="mt-4 text-sm font-medium text-accent-bright">
                    {t.attribution}
                  </figcaption>
                )}
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
