import { Reveal } from "@/components/public/Reveal";

/** A light, scannable row of "things you might not know" to show range/humor. */
export function QuirksStrip({ quirks }: { quirks: string[] }) {
  if (quirks.length === 0) return null;

  return (
    <section className="border-y border-rule bg-paper-2 py-12">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4">
          {quirks.map((q, i) => (
            <Reveal as="span" key={q} delay={i * 0.05} direction="up">
              <span className="inline-flex border border-rule bg-panel px-4 py-2 text-sm text-graphite">
                {q}
              </span>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
