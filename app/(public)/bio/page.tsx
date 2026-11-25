import type { Metadata } from "next";
import { getSiteContent } from "@/lib/site/content";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";
import { SiteImage } from "@/components/public/SiteImage";
import { StickyBookCta } from "@/components/public/StickyBookCta";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Biography",
  description:
    "From a cattle ranch in Snowflake, Arizona to the U.S. Senate and the post of Ambassador to Turkiye. The story of Jeff Flake.",
  alternates: { canonical: "/bio" },
};

export default async function BioPage() {
  const c = await getSiteContent();
  const signature = c.images["signature_logo"];

  return (
    <>
      <PublicHeader signature={signature} />
      <main className="mx-auto max-w-3xl px-5 pb-24 pt-32 sm:px-8">
        <p className="eyebrow">Biography</p>
        <h1 className="mt-4 font-display text-5xl font-medium leading-tight text-oxford">
          Jeff Flake
        </h1>
        <p id="bio-intro" className="mt-5 text-lg leading-relaxed text-graphite/85">
          Senator. Ambassador. Author. A voice that challenges without
          polarizing.
        </p>

        <div className="mt-14 space-y-16">
          {c.story.map((beat, i) => {
            const imageKey = beat.image_key ?? `story_${i}`;
            return (
              <article key={`${beat.title}-${i}`}>
                <SiteImage
                  image={c.images[imageKey]}
                  imageKey={imageKey}
                  aspect="aspect-[16/9]"
                  className="border border-rule"
                  sizes="(max-width: 768px) 100vw, 768px"
                />
                <h2 className="mt-6 font-display text-3xl font-medium text-oxford">
                  {beat.title}
                </h2>
                <p className="mt-4 text-lg leading-relaxed text-graphite/85">
                  {beat.body}
                </p>
              </article>
            );
          })}
        </div>
      </main>
      <PublicFooter signature={signature} email={c.book.fallback_email} />
      <StickyBookCta triggerId="bio-intro" />
    </>
  );
}
