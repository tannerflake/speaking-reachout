"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addRule,
  deleteRule,
  toggleRule,
  type RuleFormState,
} from "@/app/actions/rules";
import type { RuleType, TailoringRule } from "@/lib/types";

const RULE_TYPE_LABEL: Record<RuleType, string> = {
  discovery_filter: "Discovery filter",
  copy_style: "Copy style",
  targeting: "Targeting",
  other: "Other",
};

const RULE_TYPE_CLASS: Record<RuleType, string> = {
  discovery_filter: "border-blue-200 bg-blue-50 text-blue-700",
  copy_style: "border-violet-200 bg-violet-50 text-violet-700",
  targeting: "border-amber-200 bg-amber-50 text-amber-700",
  other: "border-zinc-200 bg-zinc-50 text-zinc-600",
};

export function RulesManager({ rules }: { rules: TailoringRule[] }) {
  const [state, formAction, pending] = useActionState<RuleFormState, FormData>(
    addRule,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [rowPending, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  function onToggle(id: string, next: boolean) {
    start(async () => {
      await toggleRule(id, next);
      router.refresh();
    });
  }
  function onDelete(id: string) {
    start(async () => {
      await deleteRule(id);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* Add a rule */}
      <form
        ref={formRef}
        action={formAction}
        className="rounded-lg border border-zinc-200 bg-white p-4"
      >
        <label className="block text-sm font-medium text-zinc-700">
          Tell the AI how to behave
        </label>
        <p className="mt-0.5 text-xs text-zinc-400">
          Plain English. Examples: “Don&apos;t pull leads from the UK”, “No
          em-dashes in any outreach”, “Lean more academic, less political”,
          “Prioritize universities and fintech conferences”.
        </p>
        <div className="mt-2 flex items-start gap-2">
          <textarea
            name="instruction"
            rows={2}
            required
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Type an instruction…"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {pending ? "Saving…" : "Add rule"}
          </button>
        </div>
        {state.error && (
          <p className="mt-2 text-sm text-rose-600">{state.error}</p>
        )}
      </form>

      {/* Existing rules */}
      <div className="rounded-lg border border-zinc-200 bg-white">
        {rules.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">
            No rules yet. Add one above — it will apply to all future Discover
            and Draft operations.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {rules.map((r) => (
              <li key={r.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${RULE_TYPE_CLASS[r.rule_type]}`}
                    >
                      {RULE_TYPE_LABEL[r.rule_type]}
                    </span>
                    {!r.is_active && (
                      <span className="text-xs text-zinc-400">inactive</span>
                    )}
                  </div>
                  <p
                    className={`mt-1 text-sm ${r.is_active ? "text-zinc-800" : "text-zinc-400 line-through"}`}
                  >
                    {r.raw_instruction}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => onToggle(r.id, !r.is_active)}
                    disabled={rowPending}
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-60"
                  >
                    {r.is_active ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => onDelete(r.id)}
                    disabled={rowPending}
                    className="rounded-md border border-rose-200 bg-white px-2 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
