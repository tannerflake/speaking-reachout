"use client";

import { useEffect, useRef, useState } from "react";

export type MultiSelectOption = { value: string; label: string };

/**
 * Dropdown of checkboxes. An empty selection means "all" (no filter), so the
 * button shows `allLabel` then, the single label when one is picked, or a count.
 */
export function MultiSelect({
  options,
  value,
  onChange,
  allLabel,
  noun,
  className,
  ariaLabel,
}: {
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  allLabel: string;
  /** Plural noun for the count label, e.g. "statuses" -> "3 statuses". */
  noun: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(v: string) {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  const label =
    value.length === 0
      ? allLabel
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? allLabel)
        : `${value.length} ${noun}`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`${className ?? ""} flex items-center gap-1.5 ${
          value.length ? "border-blue-500 text-blue-700" : ""
        }`}
      >
        <span>{label}</span>
        <span aria-hidden className="text-xs text-zinc-400">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable
          className="absolute left-0 z-20 mt-1 min-w-48 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg"
        >
          {options.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-zinc-50"
            >
              <input
                type="checkbox"
                checked={value.includes(o.value)}
                onChange={() => toggle(o.value)}
              />
              {o.label}
            </label>
          ))}
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full border-t border-zinc-100 px-3 py-1.5 text-left text-xs text-zinc-500 hover:text-zinc-800"
            >
              Clear ({allLabel.toLowerCase()})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
