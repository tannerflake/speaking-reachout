"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { uploadSiteImage } from "@/app/actions/siteEditor";
import type { SiteImageRow } from "@/lib/site/types";

/**
 * Human-assigned image uploads. The AI editor can reference an existing
 * image_key, but only a person uploads the actual asset and assigns the key.
 */
export function ImageUploader({ images }: { images: SiteImageRow[] }) {
  const [error, setError] = useState<string | null>(null);
  const [okKey, setOkKey] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setOkKey(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    start(async () => {
      const res = await uploadSiteImage(fd);
      if (!res.ok) {
        setError(res.error ?? "Upload failed.");
        return;
      }
      setOkKey(res.image_key ?? null);
      form.reset();
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

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-zinc-700">
              Image key
            </label>
            <input
              name="image_key"
              required
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
