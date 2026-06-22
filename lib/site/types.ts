// Content shapes for the public jeffflake.com site. Every public string lives
// in the `site_content` table as a flexible JSON `data` payload keyed by
// `section_key`, so the AI site editor can change copy without a deploy.

export type SectionKey =
  | "hero"
  | "story"
  | "quirk"
  | "speaking"
  | "topic"
  | "audience_type"
  | "engagement"
  | "featured_video"
  | "media_item"
  | "testimonial"
  | "authored_book"
  | "book";

/** Section keys the AI editor is allowed to create/update/reorder/delete. */
export const EDITABLE_SECTION_KEYS: SectionKey[] = [
  "hero",
  "story",
  "quirk",
  "speaking",
  "topic",
  "audience_type",
  "engagement",
  "featured_video",
  "media_item",
  "testimonial",
  "authored_book",
  "book",
];

export interface SiteContentRow {
  id: string;
  section_key: string;
  sort_order: number;
  data: Record<string, unknown>;
  is_published: boolean;
}

export interface SiteImageRow {
  image_key: string;
  storage_path: string | null;
  alt_text: string | null;
  subject: string | null;
  /** Horizontal framing offset (-100..100), proportional to the frame. Positive moves the photo right. */
  offset_x?: number | null;
  /** Vertical framing offset (-100..100), proportional to the frame. Positive moves the photo down. */
  offset_y?: number | null;
  /** Zoom/magnification percent (100..200). 100 = fit, no zoom. */
  zoom?: number | null;
}

// ---- Typed views of each section's `data` payload -------------------------

export interface HeroData {
  kicker?: string;
  headline?: string;
  subhead?: string;
  cta_label?: string;
  image_key?: string;
}

export interface StoryStat {
  value: number;
  label: string;
}

export interface StoryData {
  title?: string;
  body?: string;
  image_key?: string;
  stats?: StoryStat[];
  tone?: "warm" | "default";
  /** Extra image keys shown as a gallery (used for the Island centerpiece). */
  gallery?: string[];
  /** Optional embedded video (YouTube) for a richer chapter. */
  video_url?: string;
  /** Optional video that plays in a modal from a play button on the photo. */
  modal_video_url?: string;
  /** CSS object-position for the main photo (e.g. "50% 20%") to reframe a crop. */
  image_position?: string;
  /** CSS aspect-ratio for the main photo (e.g. "5/4") to widen/narrow the crop. */
  image_aspect?: string;
}

export interface SpeakingData {
  eyebrow?: string;
  heading?: string;
  topics_label?: string;
  audiences_label?: string;
  engagements_label?: string;
  cta_label?: string;
}

export interface TopicData {
  title?: string;
  body?: string;
}

export interface EngagementData {
  name?: string;
  kind?: "recent" | "upcoming";
  /**
   * Optional logo shown faintly behind the card. Defaults to a slug of the name
   * (e.g. "Rutgers University" -> "rutgers_university") so any engagement gets a
   * logo slot automatically; set this to override that derived key.
   */
  image_key?: string;
}

export interface FeaturedVideoData {
  title?: string;
  caption?: string;
  video_url?: string;
  event_url?: string;
  poster_image_key?: string;
}

export interface MediaItemData {
  title?: string;
  outlet?: string;
  url?: string;
  /** Optional outlet logo/photo shown faintly behind the card (e.g. "washington_post"). */
  image_key?: string;
}

export interface TestimonialData {
  quote?: string;
  attribution?: string;
  /** Optional logo/image shown faintly behind the card (e.g. a school crest). */
  image_key?: string;
}

export interface AuthoredBookData {
  /** Small label above the title, e.g. "The Book". */
  eyebrow?: string;
  /** A short badge line, e.g. "New York Times Bestseller". */
  badge?: string;
  title?: string;
  subtitle?: string;
  /** Short description / blurb. */
  body?: string;
  /** Optional pull quote about the book. */
  quote?: string;
  quote_attribution?: string;
  /** Outbound link (e.g. the Amazon page). */
  url?: string;
  cta_label?: string;
  /** Small print: publisher, length, format. */
  meta?: string;
  image_key?: string;
}

export interface BookData {
  headline?: string;
  body?: string;
  fallback_email?: string;
  image_key?: string;
  /** CSS object-position for the portrait (e.g. "50% 20%"). */
  image_position?: string;
}

export interface LabelData {
  label?: string;
}

/** Grouped, ordered content ready for rendering. */
export interface SiteContent {
  hero: HeroData;
  story: StoryData[];
  quirks: string[];
  speaking: SpeakingData;
  topics: TopicData[];
  audienceTypes: string[];
  engagements: EngagementData[];
  featuredVideos: FeaturedVideoData[];
  mediaItems: MediaItemData[];
  testimonials: TestimonialData[];
  authoredBook: AuthoredBookData | null;
  book: BookData;
  images: Record<string, SiteImageRow>;
}
