"use client";

import { useEffect, useState } from "react";
import { SiteImage } from "@/components/public/SiteImage";
import { youTubeId } from "@/lib/site/youtube";
import type { SiteImageRow } from "@/lib/site/types";

/**
 * A story photo with a small play button overlay. Clicking it opens the video
 * in a centered modal (lightbox) with the YouTube embed; the iframe only loads
 * on open, and Escape / backdrop / the close button all dismiss it.
 */
export function StoryVideoImage({
  image,
  imageKey,
  videoUrl,
  title,
  aspect,
  aspectRatio,
  className = "",
  objectPosition,
  sizes,
}: {
  image: SiteImageRow | undefined;
  imageKey: string;
  videoUrl: string;
  title?: string;
  aspect?: string;
  aspectRatio?: string;
  className?: string;
  objectPosition?: string;
  sizes?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = youTubeId(videoUrl);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    // Lock background scroll while the modal is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="relative">
      <SiteImage
        image={image}
        imageKey={imageKey}
        aspect={aspect}
        aspectRatio={aspectRatio}
        className={className}
        objectPosition={objectPosition}
        sizes={sizes}
      />

      {id && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={title ? `Play video: ${title}` : "Play video"}
          className="group absolute inset-0 grid place-items-center bg-oxford/0 transition-colors hover:bg-oxford/15"
        >
          <span className="grid h-14 w-14 place-items-center rounded-full bg-white/95 shadow-lg transition-transform group-hover:scale-105">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M8 5v14l11-7z" fill="#15233f" />
            </svg>
          </span>
        </button>
      )}

      {open && id && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 sm:p-8"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={title ?? "Video"}
        >
          <div
            className="relative aspect-video w-full max-w-4xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close video"
              className="absolute -top-9 right-0 flex items-center gap-1.5 text-sm font-medium text-white/80 transition-colors hover:text-white"
            >
              Close
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <iframe
              className="h-full w-full border border-white/10"
              src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`}
              title={title ?? "Video"}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>
      )}
    </div>
  );
}
