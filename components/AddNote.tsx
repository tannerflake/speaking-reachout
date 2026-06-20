"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addNote } from "@/app/actions/leads";

export function AddNote({ leadId }: { leadId: string }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  function submit() {
    if (!note.trim()) return;
    start(async () => {
      await addNote(leadId, note);
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="flex items-start gap-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Add a note…"
        className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <button
        onClick={submit}
        disabled={pending || !note.trim()}
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Add note"}
      </button>
    </div>
  );
}
