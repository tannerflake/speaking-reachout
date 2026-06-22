"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { uploadSiteImage } from "@/app/actions/siteEditor";
import {
  imagePublicUrl,
  imageFrameStyle,
  clampOffset,
  clampZoom,
  MAX_IMAGE_OFFSET,
  MIN_IMAGE_ZOOM,
  MAX_IMAGE_ZOOM,
  DEFAULT_IMAGE_ZOOM,
} from "@/lib/site/images";
import type { SiteImageRow } from "@/lib/site/types";

/**
 * Human-assigned image uploads. The AI editor can reference an existing
 * image_key, but only a person uploads the actual asset and assigns the key.
 * The position sliders nudge the photo within its crop (+/- 100px each axis);
 * the live preview reframes with the exact CSS used on the public site.
 */
export function ImageUploader({ images }: { images: SiteImageRow[] }) {
  const [error, setError] = useState<string | null>(null);
  const [okKey, setOkKey] = useState<string | null>(null);
  const [imageKey, setImageKey] = useState("");
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [zoom, setZoom] = useState(DEFAULT_IMAGE_ZOOM);
  const [pending, start] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  // Release the object URL when the chosen file changes or on unmount.
  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [fileUrl]);

  const existing = images.find((img) => img.image_key === imageKey.trim());
  const previewUrl = fileUrl ?? imagePublicUrl(existing);
  const previewStyle = imageFrameStyle(undefined, offsetX, offsetY, zoom);
  const isDefault =
    offsetX === 0 && offsetY === 0 && zoom === DEFAULT_IMAGE_ZOOM;

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setFileUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      const file = e.target.files?.[0];
      return file ? URL.createObjectURL(file) : null;
    });
  }

  function onKeyChange(value: string) {
    setImageKey(value);
    // Pre-fill the sliders from a known key so re-uploads start where the
    // photo currently sits (only when no new file is staged for preview).
    if (!fileUrl) {
      const match = images.find((img) => img.image_key === value.trim());
      if (match) {
        setOffsetX(clampOffset(match.offset_x));
        setOffsetY(clampOffset(match.offset_y));
        setZoom(clampZoom(match.zoom));
      }
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOkKey(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("offset_x", String(offsetX));
    fd.set("offset_y", String(offsetY));
    fd.set("zoom", String(zoom));
    start(async () => {
      const res = await uploadSiteImage(fd);
      if (!res.ok) {
        setError(res.error ?? "Upload failed.");
        return;
      }
      setOkKey(res.image_key ?? null);
      form.reset();
      setImageKey("");
      setOffsetX(0);
      setOffsetY(0);
      setZoom(DEFAULT_IMAGE_ZOOM);
      setFileUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      router.refresh();
    });
  }

  const field =
    "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-zinc-900">Images</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Upload a real photo for any placeholder key. Re-uploading an existing
        key replaces that image across the site.
      </p>

      <form ref={formRef} onSubmit={onSubmit} className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-zinc-700">
              Image key
            </label>
            <input
              name="image_key"
              required
              value={imageKey}
              onChange={(e) => onKeyChange(e.target.value)}
              placeholder="hero_primary"
              list="image-keys"
              className={field}
            />
            <datalist id="image-keys">
              {images.map((img) => (
                <option key={img.image_key} value={img.image_key} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700">
              File
            </label>
            <input
              name="file"
              type="file"
              accept="image/*"
              required
              onChange={onFileChange}
              className="mt-1 w-full text-sm text-zinc-600 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700">
            Alt text (for accessibility)
          </label>
          <input name="alt_text" className={field} />
        </div>

        {/* Framing — nudge the photo within its crop, +/- 100px per axis. */}
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-zinc-700">
              Position &amp; zoom
            </label>
            <button
              type="button"
              onClick={() => {
                setOffsetX(0);
                setOffsetY(0);
                setZoom(DEFAULT_IMAGE_ZOOM);
              }}
              disabled={isDefault}
              className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:text-zinc-400"
            >
              Reset
            </button>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Slide to reframe or zoom the photo. The preview matches the live
            site.
          </p>

          <div className="mt-3 grid gap-4 sm:grid-cols-[1fr_auto]">
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs text-zinc-500">
                  <span>← Left</span>
                  <span className="font-mono text-zinc-700">
                    {offsetX > 0 ? "+" : ""}
                    {Math.round(offsetX / 2)}%
                  </span>
                  <span>Right →</span>
                </div>
                <input
                  type="range"
                  min={-MAX_IMAGE_OFFSET}
                  max={MAX_IMAGE_OFFSET}
                  step={1}
                  value={offsetX}
                  onChange={(e) => setOffsetX(Number(e.target.value))}
                  className="mt-1 w-full accent-blue-600"
                  aria-label="Horizontal position"
                />
              </div>
              <div>
                <div className="flex items-center justify-between text-xs text-zinc-500">
                  <span>↑ Up</span>
                  <span className="font-mono text-zinc-700">
                    {offsetY > 0 ? "+" : ""}
                    {Math.round(offsetY / 2)}%
                  </span>
                  <span>Down ↓</span>
                </div>
                <input
                  type="range"
                  min={-MAX_IMAGE_OFFSET}
                  max={MAX_IMAGE_OFFSET}
                  step={1}
                  value={offsetY}
                  onChange={(e) => setOffsetY(Number(e.target.value))}
                  className="mt-1 w-full accent-blue-600"
                  aria-label="Vertical position"
                />
              </div>
              <div>
                <div className="flex items-center justify-between text-xs text-zinc-500">
                  <span>Fit</span>
                  <span className="font-mono text-zinc-700">{zoom}%</span>
                  <span>Zoom in</span>
                </div>
                <input
                  type="range"
                  min={MIN_IMAGE_ZOOM}
                  max={MAX_IMAGE_ZOOM}
                  step={1}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="mt-1 w-full accent-blue-600"
                  aria-label="Zoom"
                />
              </div>
            </div>

            {/* Live preview using the exact framing CSS the site applies. */}
            <div className="relative h-32 w-full overflow-hidden rounded-md border border-zinc-300 bg-zinc-100 sm:w-44">
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt="Position preview"
                  className="h-full w-full object-cover"
                  style={previewStyle}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-zinc-400">
                  Choose a file or key to preview
                </div>
              )}
              {/* Faint center guides so the nudge is easy to judge. */}
              <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/40" />
              <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/40" />
            </div>
          </div>
        </div>

        {error && <p className="text-sm text-rose-600">{error}</p>}
        {okKey && (
          <p className="text-sm text-emerald-700">
            Uploaded and assigned to <span className="font-mono">{okKey}</span>.
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? "Uploading…" : "Upload image"}
        </button>
      </form>

      <div className="mt-5">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Image keys
        </p>
        <div className="flex flex-wrap gap-2">
          {images.map((img) => (
            <span
              key={img.image_key}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                img.storage_path
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-zinc-200 bg-zinc-50 text-zinc-500"
              }`}
              title={img.subject ?? undefined}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  img.storage_path ? "bg-emerald-500" : "bg-zinc-300"
                }`}
              />
              {img.image_key}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
