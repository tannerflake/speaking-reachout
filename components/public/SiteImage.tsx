import Image from "next/image";
import { imagePublicUrl } from "@/lib/site/images";
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
  className = "",
  imgClassName = "",
  sizes = "100vw",
  priority = false,
}: {
  image: SiteImageRow | undefined;
  imageKey: string;
  aspect?: string;
  className?: string;
  /** Extra classes for the <img> itself (e.g. responsive object-position). */
  imgClassName?: string;
  sizes?: string;
  priority?: boolean;
}) {
  const url = imagePublicUrl(image);
  const alt = image?.alt_text ?? imageKey;

  return (
    <div
      className={`relative overflow-hidden ${aspect} ${className}`}
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
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-navy-800 p-4 text-center">
          <span className="rounded bg-navy-700 px-2 py-0.5 font-mono text-[11px] tracking-wide text-accent-bright">
            {imageKey}
          </span>
          {image?.subject && (
            <span className="max-w-[80%] text-xs leading-snug text-white/45">
              {image.subject}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
