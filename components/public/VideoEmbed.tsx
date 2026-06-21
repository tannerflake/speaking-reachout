"use client";

import { useState } from "react";

/** Extract a YouTube video id from common URL shapes (or a bare id). */
function youTubeId(input: string): string | null {
  const url = input.trim();
  if (!url) return null;
  if (/^[\w-]{11}$/.test(url)) return url;
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * Responsive 16:9 video module. Shows a poster with a play button and only
 * loads the YouTube iframe on click (no autoload), for fast LCP.
 */
export function VideoEmbed({
  videoUrl,
  posterUrl,
  posterKey,
  posterSubject,
  caption,
}: {
  videoUrl: string;
  posterUrl: string | null;
  posterKey: string;
  posterSubject: string | null;
  caption?: string;
}) {
  const [playing, setPlaying] = useState(false);
  const id = youTubeId(videoUrl);

  return (
    <div className="overflow-hidden rounded-2xl ring-1 ring-white/10">
      <div className="relative aspect-video bg-navy-800">
        {playing && id ? (
          <iframe
            className="absolute inset-0 h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`}
            title={caption ?? "Featured video"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <>
            {/* Poster */}
            {posterUrl ? (
              // Plain img: the poster is below the fold and swaps to an iframe.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={posterUrl}
                alt={caption ?? "Featured talk"}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-navy-800 text-center">
                <span className="rounded bg-navy-700 px-2 py-0.5 font-mono text-[11px] text-accent-bright">
                  {posterKey}
                </span>
                {posterSubject && (
                  <span className="text-xs text-white/45">{posterSubject}</span>
                )}
              </div>
            )}
            <div className="absolute inset-0 bg-navy-950/30" />

            {id ? (
              <button
                type="button"
                onClick={() => setPlaying(true)}
                aria-label="Play video"
                className="group absolute inset-0 grid place-items-center"
              >
                <span className="grid h-20 w-20 place-items-center rounded-full bg-white/95 shadow-xl transition-transform group-hover:scale-105">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M8 5v14l11-7z" fill="#0f1830" />
                  </svg>
                </span>
              </button>
            ) : (
              <div className="absolute inset-x-0 bottom-0 bg-navy-950/70 px-4 py-3 text-center text-sm text-white/70">
                Video coming soon.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
