"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  pauseSequence,
  resumeSequence,
  sendFollowupNow,
} from "@/app/actions/followups";
import type { Contact, FollowupSequence } from "@/lib/types";
import { formatDate } from "@/lib/utils";

const STATUS_LABEL: Record<FollowupSequence["status"], string> = {
  active: "Scheduled",
  paused: "Paused",
  completed: "Done",
  stopped: "Stopped",
};

const STATUS_CLASS: Record<FollowupSequence["status"], string> = {
  active: "bg-indigo-50 text-indigo-700 border-indigo-200",
  paused: "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-zinc-100 text-zinc-600 border-zinc-200",
  stopped: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

/**
 * Per-lead view of automated follow-up sequences (one per emailed contact):
 * where each is in the cadence, when the next nudge goes out, and controls
 * to pause, resume, or send now.
 */
export function FollowupsPanel({
  sequences,
  contacts,
}: {
  sequences: FollowupSequence[];
  contacts: Contact[];
}) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  if (sequences.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        Follow-ups start automatically once an outreach email is sent: three
        short nudges in the same thread around days 4, 11, and 21, stopping the
        moment they reply.
      </p>
    );
  }

  function run(id: string, fn: () => Promise<{ error?: string; note?: string; sent?: boolean }>) {
    setMsg(null);
    setErr(null);
    setBusy(id);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (res.error) setErr(res.error);
      else if (res.note) setMsg(res.note);
      else if (res.sent) setMsg("Follow-up sent.");
      router.refresh();
    });
  }

  const btn =
    "rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60";

  return (
    <div className="space-y-2">
      {sequences.map((s) => {
        const contact = contacts.find((c) => c.id === s.contact_id) ?? null;
        const who = contact?.name ?? contact?.email ?? "contact";
        const isBusy = pending && busy === s.id;
        return (
          <div
            key={s.id}
            className="rounded-md border border-zinc-200 p-2 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-zinc-800">{who}</span>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[s.status]}`}
              >
                {STATUS_LABEL[s.status]}
              </span>
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {s.steps_sent} of {s.max_steps} sent
              {s.status === "active" && s.next_due_at
                ? ` · next on ${formatDate(s.next_due_at)}`
                : ""}
              {s.status === "stopped" && s.stop_reason
                ? ` · ${s.stop_reason}`
                : ""}
            </div>
            {s.last_error && (
              <div className="mt-1 text-xs text-rose-600">
                Last attempt failed: {s.last_error}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.status === "active" && (
                <>
                  <button
                    disabled={isBusy}
                    onClick={() => run(s.id, () => sendFollowupNow(s.id))}
                    className={btn}
                  >
                    {isBusy ? "Sending…" : "Send next now"}
                  </button>
                  <button
                    disabled={isBusy}
                    onClick={() => run(s.id, () => pauseSequence(s.id))}
                    className={btn}
                  >
                    Pause
                  </button>
                </>
              )}
              {(s.status === "paused" || s.status === "stopped") &&
                s.steps_sent < s.max_steps && (
                  <button
                    disabled={isBusy}
                    onClick={() => run(s.id, () => resumeSequence(s.id))}
                    className={btn}
                  >
                    Resume
                  </button>
                )}
            </div>
          </div>
        );
      })}
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
