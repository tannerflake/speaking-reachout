"use client";

import { useState, useTransition } from "react";
import {
  proposeChange,
  applyChange,
  type ProposeResult,
} from "@/app/actions/siteEditor";
import type { PreviewItem, SiteEditOp } from "@/lib/claude/siteEditor";
import type { SiteImageRow } from "@/lib/site/types";
import { ImageUploader } from "@/components/ImageUploader";

const EXAMPLES = [
  "Add this op-ed to In the Media: [title] + [link]",
  "Add University of San Diego to upcoming engagements.",
  "Swap the featured video to this YouTube link: [url]",
  "Change the hero subhead to: [text]",
];

type Stage = "idle" | "preview" | "done";

function KeyValues({ data }: { data: Record<string, unknown> | null }) {
  if (!data) return <span className="text-zinc-400">(removed)</span>;
  return (
    <dl className="space-y-1">
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="flex gap-2 text-xs">
          <dt className="shrink-0 font-medium text-zinc-500">{k}:</dt>
          <dd className="text-zinc-800">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const TYPE_STYLES: Record<string, string> = {
  create: "bg-emerald-50 text-emerald-700 border-emerald-200",
  update: "bg-blue-50 text-blue-700 border-blue-200",
  reorder: "bg-amber-50 text-amber-700 border-amber-200",
  delete: "bg-rose-50 text-rose-700 border-rose-200",
};

export function SiteEditor({ images }: { images: SiteImageRow[] }) {
  const [request, setRequest] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [ops, setOps] = useState<SiteEditOp[]>([]);
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [appliedCount, setAppliedCount] = useState(0);
  const [pending, start] = useTransition();

  const needsDeleteConfirm = preview.some((p) => p.needsConfirm);

  function propose() {
    setError(null);
    start(async () => {
      const res: ProposeResult = await proposeChange(request);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOps(res.ops ?? []);
      setPreview(res.preview ?? []);
      setSummary(res.summary ?? "");
      setConfirmDelete(false);
      setStage("preview");
    });
  }

  function apply() {
    setError(null);
    start(async () => {
      const res = await applyChange(ops, request, confirmDelete);
      if (!res.ok) {
        setError(res.error ?? "Could not apply the change.");
        return;
      }
      setAppliedCount(res.applied ?? 0);
      setStage("done");
    });
  }

  function reset() {
    setRequest("");
    setOps([]);
    setPreview([]);
    setSummary("");
    setError(null);
    setConfirmDelete(false);
    setStage("idle");
  }

  return (
    <div className="space-y-8">
      <div className="rounded-lg border border-zinc-200 bg-white p-5">
        <label className="block text-sm font-medium text-zinc-700">
          What would you like to change?
        </label>
        <textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          rows={4}
          disabled={stage === "preview" || pending}
          placeholder="e.g. Add University of San Diego to upcoming engagements."
          className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-zinc-50"
        />

        {stage === "idle" && (
          <>
            <div className="mt-3 flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setRequest(ex)}
                  className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
                >
                  {ex}
                </button>
              ))}
            </div>
            <button
              onClick={propose}
              disabled={pending || !request.trim()}
              className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {pending ? "Thinking…" : "Propose change"}
            </button>
          </>
        )}

        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      </div>

      {stage === "preview" && (
        <div className="rounded-lg border border-zinc-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-zinc-900">Preview</h2>
          {summary && <p className="mt-1 text-sm text-zinc-600">{summary}</p>}

          {preview.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">
              No change to apply. Edit your request and propose again.
            </p>
          ) : (
            <ul className="mt-4 space-y-4">
              {preview.map((p, i) => (
                <li
                  key={i}
                  className="rounded-md border border-zinc-200 p-4"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
                        TYPE_STYLES[p.type] ?? ""
                      }`}
                    >
                      {p.type}
                    </span>
                    <span className="text-xs uppercase tracking-wide text-zinc-400">
                      {p.section_key}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-zinc-800">{p.label}</p>
                  {(p.before || p.after) && (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className="rounded bg-zinc-50 p-3">
                        <p className="mb-1 text-[11px] font-semibold uppercase text-zinc-400">
                          Before
                        </p>
                        <KeyValues data={p.before} />
                      </div>
                      <div className="rounded bg-zinc-50 p-3">
                        <p className="mb-1 text-[11px] font-semibold uppercase text-zinc-400">
                          After
                        </p>
                        <KeyValues data={p.after} />
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {needsDeleteConfirm && (
            <label className="mt-4 flex items-center gap-2 text-sm text-rose-700">
              <input
                type="checkbox"
                checked={confirmDelete}
                onChange={(e) => setConfirmDelete(e.target.checked)}
              />
              I understand this permanently deletes content.
            </label>
          )}

          <div className="mt-5 flex gap-3">
            <button
              onClick={apply}
              disabled={
                pending ||
                preview.length === 0 ||
                (needsDeleteConfirm && !confirmDelete)
              }
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {pending ? "Applying…" : "Apply"}
            </button>
            <button
              onClick={reset}
              disabled={pending}
              className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {stage === "done" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5">
          <p className="text-sm font-medium text-emerald-800">
            Applied {appliedCount} change{appliedCount === 1 ? "" : "s"}. The
            site updates within a moment.
          </p>
          <div className="mt-3 flex gap-3">
            <button
              onClick={reset}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Make another change
            </button>
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              View site
            </a>
          </div>
        </div>
      )}

      <ImageUploader images={images} />
    </div>
  );
}
