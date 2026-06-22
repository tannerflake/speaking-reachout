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

/** Zoom bounds (percent). 100 = fit/no zoom. Kept in sync with the DB check. */
export const MIN_IMAGE_ZOOM = 100;
export const MAX_IMAGE_ZOOM = 200;
export const DEFAULT_IMAGE_ZOOM = 100;

/** Coerce any input to a whole-pixel offset within [-MAX, MAX]. */
export function clampOffset(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(-MAX_IMAGE_OFFSET, Math.min(MAX_IMAGE_OFFSET, Math.round(value)));
}

/** Coerce any input to a whole-percent zoom within [MIN, MAX]. */
export function clampZoom(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_IMAGE_ZOOM;
  return Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, Math.round(value)));
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

/** Style object an image renders with: pan via object-position, zoom via a
 * scale() transform anchored at the pan point. Shared by the public site and
 * the uploader preview so both reframe identically. Undefined when there is
 * nothing to apply (centered, no zoom). */
export function imageFrameStyle(
  base: string | undefined,
  offsetX: number | null | undefined,
  offsetY: number | null | undefined,
  zoom: number | null | undefined,
): { objectPosition?: string; transform?: string; transformOrigin?: string } | undefined {
  const position = imageObjectPosition(base, offsetX, offsetY);
  const z = clampZoom(zoom);
  const style: { objectPosition?: string; transform?: string; transformOrigin?: string } = {};
  if (position) style.objectPosition = position;
  if (z !== DEFAULT_IMAGE_ZOOM) {
    style.transform = `scale(${z / 100})`;
    // Anchor the zoom at the pan focal point so panning + zoom stay coherent.
    style.transformOrigin = position ?? "center";
  }
  return Object.keys(style).length > 0 ? style : undefined;
}
