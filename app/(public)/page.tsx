import { getSiteContent } from "@/lib/site/content";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";
import { JsonLd } from "@/components/public/JsonLd";
import { Hero } from "@/components/public/sections/Hero";
import { StorySection } from "@/components/public/sections/StorySection";
import { QuirksStrip } from "@/components/public/sections/QuirksStrip";
import { SpeakingSection } from "@/components/public/sections/SpeakingSection";
import { FeaturedVideo } from "@/components/public/sections/FeaturedVideo";
import { MediaSection } from "@/components/public/sections/MediaSection";
import { Testimonials } from "@/components/public/sections/Testimonials";
import { BookSection } from "@/components/public/sections/BookSection";

// Rendered dynamically so AI-editor changes appear immediately and the build
// never depends on a reachable database.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const c = await getSiteContent();
  const signature = c.images["signature_logo"];

  return (
    <>
      <JsonLd />
      <PublicHeader signature={signature} />
      <main>
        <Hero data={c.hero} images={c.images} />
        <StorySection story={c.story} images={c.images} />
        <QuirksStrip quirks={c.quirks} />
        <SpeakingSection
          topics={c.topics}
          audienceTypes={c.audienceTypes}
          engagements={c.engagements}
        />
        <FeaturedVideo data={c.featuredVideo} images={c.images} />
        <MediaSection items={c.mediaItems} />
        <Testimonials items={c.testimonials} images={c.images} />
        <BookSection data={c.book} images={c.images} />
      </main>
      <PublicFooter signature={signature} email={c.book.fallback_email} />
    </>
  );
}
