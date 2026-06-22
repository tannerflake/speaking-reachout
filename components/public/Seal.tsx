import Image from "next/image";

/**
 * The Great Seal emblem, used as a crest preceding the signature wordmark in
 * the header and footer. Static brand asset served from /public. Decorative —
 * the adjacent signature already names the brand for assistive tech.
 */
export function Seal({
  size = 44,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src="/seal.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      style={{ width: size, height: size }}
      priority
    />
  );
}
