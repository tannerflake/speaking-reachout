import type { SiteImageRow } from "@/lib/site/types";

/**
 * Public URL for a stored site image, or null if no asset is uploaded yet.
 * Pure (no server-only imports) so it is safe in client and server components.
 * Assets live in the public Supabase Storage bucket `site-images`.
 */
export function imagePublicUrl(image: SiteImageRow | undefined): string | null {
  if (!image?.storage_path) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/site-images/${image.storage_path}`;
}

/** Max framing nudge, in px, on each axis. Kept in sync with the DB check. */
export const MAX_IMAGE_OFFSET = 100;

/** Coerce any input to a whole-pixel offset within [-MAX, MAX]. */
export function clampOffset(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(-MAX_IMAGE_OFFSET, Math.min(MAX_IMAGE_OFFSET, Math.round(value)));
}

/**
 * Final CSS object-position for an image, composing an optional base position
 * (e.g. a section's "50% 20%") with the image's own pixel framing offsets.
 * Positive offsetX moves the photo right; positive offsetY moves it down.
 * Returns undefined when there is nothing to set (centered, no offset) so the
 * browser default stands.
 */
export function imageObjectPosition(
  base: string | undefined,
  offsetX: number | null | undefined,
  offsetY: number | null | undefined,
): string | undefined {
  const ox = clampOffset(offsetX);
  const oy = clampOffset(offsetY);
  if (!base && ox === 0 && oy === 0) return undefined;
  const parts = (base ?? "50% 50%").trim().split(/\s+/);
  const baseX = parts[0] ?? "50%";
  const baseY = parts[1] ?? parts[0] ?? "50%";
  // object-fit: cover slides the source the opposite way, so subtract to make
  // a positive offset move the visible photo in the intuitive direction.
  const nudge = (b: string, o: number) =>
    o === 0 ? b : `calc(${b} ${o < 0 ? "+" : "-"} ${Math.abs(o)}px)`;
  return `${nudge(baseX, ox)} ${nudge(baseY, oy)}`;
}
