import type { Metadata } from "next";
import Link from "next/link";
import { getSiteContent } from "@/lib/site/content";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";
import { SiteImage } from "@/components/public/SiteImage";

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
        <p className="text-sm font-medium uppercase tracking-[0.25em] text-accent-bright">
          Biography
        </p>
        <h1 className="mt-3 font-display text-5xl font-semibold leading-tight text-white">
          Jeff Flake
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-white/75">
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
                  className="rounded-2xl ring-1 ring-white/10"
                  sizes="(max-width: 768px) 100vw, 768px"
                />
                <h2 className="mt-6 font-display text-3xl font-semibold text-white">
                  {beat.title}
                </h2>
                <p className="mt-4 text-lg leading-relaxed text-white/75">
                  {beat.body}
                </p>
              </article>
            );
          })}
        </div>

        <div className="mt-16">
          <Link
            href="/#book"
            className="inline-flex items-center gap-2 rounded-full bg-accent px-7 py-3.5 text-base font-semibold text-white transition-colors hover:bg-accent-bright"
          >
            Book Jeff as a speaker
            <span aria-hidden>&rarr;</span>
          </Link>
        </div>
      </main>
      <PublicFooter signature={signature} email={c.book.fallback_email} />
    </>
  );
}
