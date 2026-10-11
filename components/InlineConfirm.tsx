"use client";

import { useState, type ReactNode } from "react";

interface PendingConfirm {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/**
 * In-page replacement for window.confirm. Browser confirm dialogs can be
 * silently suppressed (Chrome's "prevent this page from creating additional
 * dialogs", embedded webviews, some privacy settings), in which case the
 * action never runs and nothing visible happens. Rendering the question in
 * the page removes that dependency.
 *
 * Usage: const { ask, confirmEl } = useInlineConfirm();
 *        ask("Really do this?", () => doIt());   // then render {confirmEl}
 */
export function useInlineConfirm(): {
  ask: (message: string, onConfirm: () => void, confirmLabel?: string) => void;
  confirmEl: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  function ask(
    message: string,
    onConfirm: () => void,
    confirmLabel = "Confirm",
  ) {
    setPending({ message, onConfirm, confirmLabel });
  }

  const confirmEl = pending ? (
    <div
      role="alertdialog"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <span className="whitespace-pre-line">{pending.message}</span>
      <span className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setPending(null)}
          className="rounded-md border border-amber-300 bg-white px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
        >
          Cancel
        </button>
        <button
          type="button"
          autoFocus
          onClick={() => {
            const run = pending.onConfirm;
            setPending(null);
            run();
          }}
          className="rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
        >
          {pending.confirmLabel}
        </button>
      </span>
    </div>
  ) : null;

  return { ask, confirmEl };
}
