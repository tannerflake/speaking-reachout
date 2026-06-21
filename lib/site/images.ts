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
