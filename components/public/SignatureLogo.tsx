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
        width={height * 4}
        className={`h-auto w-auto ${className}`}
        style={{ height }}
        priority
      />
    );
  }

  return (
    <span
      className={`font-display text-2xl italic leading-none text-white ${className}`}
    >
      Jeff Flake
    </span>
  );
}
