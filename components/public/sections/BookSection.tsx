import { SiteImage } from "@/components/public/SiteImage";
import { Reveal } from "@/components/public/Reveal";
import { PublicBookingForm } from "@/components/public/PublicBookingForm";
import type { BookData, SiteImageRow } from "@/lib/site/types";

export function BookSection({
  data,
  images,
}: {
  data: BookData;
  images: Record<string, SiteImageRow>;
}) {
  const imageKey = data.image_key ?? "book_portrait";
  const fallbackEmail = data.fallback_email ?? "cheryl@jeffflake.com";

  return (
    <section
      id="book"
      className="scroll-mt-20 border-t border-white/10 bg-navy-900 py-20 sm:py-28"
    >
      <div className="mx-auto grid max-w-6xl gap-12 px-5 sm:px-8 lg:grid-cols-2 lg:items-center lg:gap-16">
        <Reveal direction="right">
          <div>
            <SiteImage
              image={images[imageKey]}
              imageKey={imageKey}
              aspect="aspect-[4/5]"
              className="rounded-3xl ring-1 ring-white/10"
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
          </div>
        </Reveal>

        <Reveal direction="left" delay={0.1}>
          <div>
            <h2 className="font-display text-4xl font-semibold leading-tight text-white sm:text-5xl">
              {data.headline ?? "Book Jeff Flake as a speaker."}
            </h2>
            {data.body && (
              <p className="mt-4 text-lg leading-relaxed text-white/70">
                {data.body}
              </p>
            )}
            <div className="mt-8">
              <PublicBookingForm fallbackEmail={fallbackEmail} />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
