import type { Metadata } from "next";
import { getSiteContent } from "@/lib/site/content";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";
import { MediaSection } from "@/components/public/sections/MediaSection";
import { FeaturedVideo } from "@/components/public/sections/FeaturedVideo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "In the Media",
  description:
    "Op-eds, essays, and appearances from Ambassador Jeff Flake, plus featured conversations.",
  alternates: { canonical: "/media" },
};

export default async function MediaPage() {
  const c = await getSiteContent();
  const signature = c.images["signature_logo"];

  return (
    <>
      <PublicHeader signature={signature} />
      <main className="pt-20">
        <div className="mx-auto max-w-6xl px-5 pt-12 sm:px-8">
          <h1 className="font-display text-5xl font-medium text-oxford">
            In the Media
          </h1>
        </div>
        <MediaSection items={c.mediaItems} />
        <FeaturedVideo data={c.featuredVideo} images={c.images} />
      </main>
      <PublicFooter signature={signature} email={c.book.fallback_email} />
    </>
  );
}
