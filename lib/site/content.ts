import type { SupabaseClient } from "@supabase/supabase-js";
import { createPublicClient } from "@/lib/supabase/public";
import { clampOffset, clampZoom } from "@/lib/site/images";
import type {
  BookData,
  EngagementData,
  FeaturedVideoData,
  HeroData,
  LabelData,
  MediaItemData,
  SiteContent,
  SiteContentRow,
  SiteImageRow,
  StoryData,
  TestimonialData,
  TopicData,
} from "@/lib/site/types";

function bySort(a: SiteContentRow, b: SiteContentRow): number {
  return a.sort_order - b.sort_order;
}

const IMAGE_COLS_BASE = "image_key, storage_path, alt_text, subject";

/**
 * Read all site_images rows with framing (offset_x/offset_y/zoom) normalized to
 * numbers. Falls back to the base columns if the framing migration (0005) has
 * not been applied yet, so image rendering never breaks on a pending migration.
 */
export async function fetchSiteImageRows(
  supabase: SupabaseClient,
): Promise<SiteImageRow[]> {
  const withFraming = await supabase
    .from("site_images")
    .select(`${IMAGE_COLS_BASE}, offset_x, offset_y, zoom`)
    .order("image_key");
  let data = withFraming.data as SiteImageRow[] | null;
  if (withFraming.error) {
    const base = await supabase
      .from("site_images")
      .select(IMAGE_COLS_BASE)
      .order("image_key");
    data = base.data as SiteImageRow[] | null;
  }
  const rows = data ?? [];
  return rows.map((r) => ({
    ...r,
    offset_x: clampOffset(r.offset_x),
    offset_y: clampOffset(r.offset_y),
    zoom: clampZoom(r.zoom),
  }));
}

function rowsFor(rows: SiteContentRow[], key: string): SiteContentRow[] {
  return rows.filter((r) => r.section_key === key).sort(bySort);
}

function firstData<T>(rows: SiteContentRow[], key: string, fallback: T): T {
  const row = rowsFor(rows, key)[0];
  return (row?.data as T) ?? fallback;
}

function labels(rows: SiteContentRow[], key: string): string[] {
  return rowsFor(rows, key)
    .map((r) => (r.data as LabelData).label)
    .filter((l): l is string => Boolean(l));
}

async function fetchSiteContent(): Promise<SiteContent> {
  const supabase = createPublicClient();

  const [{ data: content }, imageRows] = await Promise.all([
    supabase
      .from("site_content")
      .select("id, section_key, sort_order, data, is_published")
      .eq("is_published", true),
    fetchSiteImageRows(supabase),
  ]);

  const rows = (content as SiteContentRow[]) ?? [];
  const imageMap: Record<string, SiteImageRow> = {};
  for (const img of imageRows) imageMap[img.image_key] = img;

  return {
    hero: firstData<HeroData>(rows, "hero", {}),
    story: rowsFor(rows, "story").map((r) => r.data as StoryData),
    quirks: labels(rows, "quirk"),
    topics: rowsFor(rows, "topic").map((r) => r.data as TopicData),
    audienceTypes: labels(rows, "audience_type"),
    engagements: rowsFor(rows, "engagement").map(
      (r) => r.data as EngagementData,
    ),
    featuredVideos: rowsFor(rows, "featured_video").map(
      (r) => r.data as FeaturedVideoData,
    ),
    mediaItems: rowsFor(rows, "media_item").map((r) => r.data as MediaItemData),
    testimonials: rowsFor(rows, "testimonial").map(
      (r) => r.data as TestimonialData,
    ),
    book: firstData<BookData>(rows, "book", {}),
    images: imageMap,
  };
}

export { imagePublicUrl } from "@/lib/site/images";

/**
 * Read all public content for rendering. Pages that use it are rendered
 * dynamically (force-dynamic), so AI-editor changes appear immediately with no
 * deploy. The queries are small and fast; the LCP is dominated by imagery.
 */
export async function getSiteContent(): Promise<SiteContent> {
  return fetchSiteContent();
}

/**
 * Uncached read of the raw rows for a set of section keys. Used server-side by
 * the AI editor to assemble its working context (must always see live data).
 */
export async function getRawContentForSections(
  sectionKeys: string[],
): Promise<SiteContentRow[]> {
  const supabase = createPublicClient();
  const { data } = await supabase
    .from("site_content")
    .select("id, section_key, sort_order, data, is_published")
    .in("section_key", sectionKeys)
    .order("section_key")
    .order("sort_order");
  return (data as SiteContentRow[]) ?? [];
}
