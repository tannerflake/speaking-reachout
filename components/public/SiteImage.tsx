import Image from "next/image";
import { imagePublicUrl, imageFrameStyle } from "@/lib/site/images";
import type { SiteImageRow } from "@/lib/site/types";

/**
 * Renders a real uploaded image (via next/image) when one exists, otherwise a
 * labeled gray placeholder so Tanner can see exactly what asset belongs where.
 * All placeholders become real purely by uploading in the site editor; no code
 * change needed.
 */
export function SiteImage({
  image,
  imageKey,
  aspect = "aspect-[4/3]",
  aspectRatio,
  className = "",
  imgClassName = "",
  objectPosition,
  sizes = "100vw",
  priority = false,
}: {
  image: SiteImageRow | undefined;
  imageKey: string;
  aspect?: string;
  /** CSS aspect-ratio (e.g. "5/4") to override the default crop shape. */
  aspectRatio?: string;
  className?: string;
  /** Extra classes for the <img> itself (e.g. responsive object-position). */
  imgClassName?: string;
  /** CSS object-position (e.g. "50% 20%") to reframe a cropped photo. */
  objectPosition?: string;
  sizes?: string;
  priority?: boolean;
}) {
  const url = imagePublicUrl(image);
  const alt = image?.alt_text ?? imageKey;
  // Compose the section's optional crop position with this image's own pan + zoom.
  const frameStyle = imageFrameStyle(
    objectPosition,
    image?.offset_x,
    image?.offset_y,
    image?.zoom,
  );

  return (
    <div
      className={`relative overflow-hidden ${aspectRatio ? "" : aspect} ${className}`}
      style={aspectRatio ? { aspectRatio } : undefined}
      aria-hidden={url ? undefined : true}
    >
      {url ? (
        <Image
          src={url}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          className={`object-cover ${imgClassName}`}
          style={frameStyle}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 border border-rule bg-paper-2 p-4 text-center">
          <span className="bg-oxford/10 px-2 py-0.5 font-mono text-[11px] tracking-wide text-oxford">
            {imageKey}
          </span>
          {image?.subject && (
            <span className="max-w-[80%] text-xs leading-snug text-slate">
              {image.subject}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
