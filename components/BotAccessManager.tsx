"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { generateBotApiKey, revokeBotApiKey, rotateBotApiKeys } from "@/app/actions/botAccess";

const inputClass =
  "rounded-md border border-zinc-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

/** Generate / rotate keys. The raw key is shown once, right here. */
export function BotKeyActions({ hasActive }: { hasActive: boolean }) {
  const [label, setLabel] = useState("Jeff's bot");
  const [mode, setMode] = useState<"idle" | "rotate">("idle");
  const [confirm, setConfirm] = useState("");
  const [raw, setRaw] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function done(res: { error?: string; rawKey?: string; revoked?: number }) {
    if (res.rawKey) {
      setRaw(res.rawKey);
      setCopied(false);
    }
    setMsg(
      res.error ??
        (res.revoked !== undefined ? `New key created; ${res.revoked} old key${res.revoked === 1 ? "" : "s"} revoked.` : "New key created."),
    );
    setMode("idle");
    setConfirm("");
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          aria-label="Key label"
          className={`${inputClass} w-56`}
        />
        <button
          type="button"
          disabled={pending || !label.trim()}
          onClick={() => start(async () => done(await generateBotApiKey(label)))}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          Generate new key
        </button>
        {hasActive && (
          <button
            type="button"
            disabled={pending}
            onClick={() => setMode(mode === "rotate" ? "idle" : "rotate")}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
          >
            Rotate
          </button>
        )}
      </div>
      {mode === "rotate" && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>
            Rotate creates a new key labeled &quot;{label.trim() || "…"}&quot; and revokes
            every other active key at once. The bot stops working until it has the new
            key. Type <span className="font-mono font-semibold">ROTATE</span> to confirm.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} aria-label="Type ROTATE" />
            <button
              type="button"
              disabled={pending || confirm.trim() !== "ROTATE" || !label.trim()}
              onClick={() => start(async () => done(await rotateBotApiKeys(label, confirm)))}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
            >
              Rotate keys
            </button>
          </div>
        </div>
      )}
      {raw && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm">
          <p className="font-semibold text-emerald-900">Copy this now. It will not be shown again.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-white px-2 py-1 font-mono text-xs text-zinc-900">{raw}</code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(raw);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
              className="rounded-md border border-emerald-300 bg-white px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setRaw(null)}
              className="text-xs text-zinc-500 hover:underline"
            >
              I saved it, hide
            </button>
          </div>
        </div>
      )}
      {msg && <p className="text-sm text-zinc-600">{msg}</p>}
    </div>
  );
}

/** Per-key revoke with a typed confirmation. */
export function RevokeKeyButton({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-rose-600 hover:underline">
        Revoke
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-zinc-600">
        Type <span className="font-mono font-semibold">REVOKE</span> to revoke &quot;{label}&quot;:
      </span>
      <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className={`${inputClass} w-24 py-0.5 text-xs`} aria-label="Type REVOKE" />
      <button
        type="button"
        disabled={pending || confirm.trim() !== "REVOKE"}
        onClick={() =>
          start(async () => {
            const res = await revokeBotApiKey(id, confirm);
            if (res.error) setErr(res.error);
            else {
              setOpen(false);
              router.refresh();
            }
          })
        }
        className="rounded bg-rose-600 px-2 py-0.5 text-xs font-medium text-white disabled:opacity-60"
      >
        Revoke
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:underline">
        Cancel
      </button>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </div>
  );
}
