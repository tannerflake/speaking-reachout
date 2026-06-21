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
      className="scroll-mt-20 border-t border-rule bg-paper py-20 sm:py-28"
    >
      <div className="mx-auto grid max-w-6xl gap-12 px-5 sm:px-8 lg:grid-cols-2 lg:items-center lg:gap-16">
        <Reveal direction="right">
          <div>
            <SiteImage
              image={images[imageKey]}
              imageKey={imageKey}
              aspect="aspect-[4/5]"
              className="border border-rule"
              objectPosition={data.image_position}
              sizes="(max-width: 1024px) 100vw, 50vw"
            />
          </div>
        </Reveal>

        <Reveal direction="left" delay={0.1}>
          <div>
            <h2 className="font-display text-4xl font-medium leading-tight text-oxford sm:text-5xl">
              {data.headline ?? "Book Jeff Flake as a speaker."}
            </h2>
            {data.body && (
              <p className="mt-4 text-lg leading-relaxed text-graphite/80">
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
