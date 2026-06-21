import Image from "next/image";
import { imagePublicUrl } from "@/lib/site/images";
import type { SiteImageRow } from "@/lib/site/types";

/**
 * The handwritten-signature wordmark is the primary logo. Renders the uploaded
 * signature_logo asset when present; until Tanner supplies it, falls back to a
 * styled wordmark so the header/footer still read as a brand.
 */
export function SignatureLogo({
  image,
  className = "",
  height = 34,
}: {
  image: SiteImageRow | undefined;
  className?: string;
  height?: number;
}) {
  const url = imagePublicUrl(image);

  if (url) {
    return (
      <Image
        src={url}
        alt={image?.alt_text ?? "Jeff Flake"}
        height={height}
        // Generous width hint; the browser scales to the asset's true aspect
        // ratio (fixed height, auto width), so the signature is never distorted.
        width={height * 6}
        className={`w-auto ${className}`}
        style={{ height, width: "auto" }}
        priority
      />
    );
  }

  // Fallback wordmark scales with the same height so swapping in a real
  // signature keeps the header/footer proportions consistent.
  return (
    <span
      className={`font-display italic leading-none text-white ${className}`}
      style={{ fontSize: Math.round(height * 0.95) }}
    >
      Jeff Flake
    </span>
  );
}
