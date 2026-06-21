import { Reveal } from "@/components/public/Reveal";

/** A light, scannable row of "things you might not know" to show range/humor. */
export function QuirksStrip({ quirks }: { quirks: string[] }) {
  if (quirks.length === 0) return null;

  return (
    <section className="border-y border-white/10 bg-navy-900 py-12">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4">
          {quirks.map((q, i) => (
            <Reveal as="span" key={q} delay={i * 0.05} direction="up">
              <span className="inline-flex rounded-full border border-white/15 bg-white/[0.03] px-4 py-2 text-sm text-white/80">
                {q}
              </span>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
