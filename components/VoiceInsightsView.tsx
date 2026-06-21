"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  acceptAllSuggestedRules,
  acceptSuggestedRule,
  runVoiceAnalysis,
  type VoiceRunSummary,
} from "@/app/actions/voice";
import type { EmailInsight, InsightCategory, VoiceProfile } from "@/lib/types";
import { formatDate } from "@/lib/utils";

const CATEGORIES: Array<{
  key: InsightCategory;
  label: string;
  summaryOf: (p: VoiceProfile) => string | null;
}> = [
  { key: "voice", label: "Voice & tone", summaryOf: (p) => p.tone_summary },
  { key: "tactics", label: "Winning tactics", summaryOf: (p) => p.tactics_summary },
  { key: "structure", label: "Pitch structure", summaryOf: (p) => p.structure_summary },
  { key: "cadence", label: "Follow-up cadence", summaryOf: (p) => p.cadence_summary },
];

export function VoiceInsightsView({
  profile,
  insights,
  gmail,
}: {
  profile: VoiceProfile | null;
  insights: EmailInsight[];
  gmail: { connected: boolean; email: string | null; canRead: boolean };
}) {
  const [pending, start] = useTransition();
  const [summary, setSummary] = useState<VoiceRunSummary | null>(null);
  const [ruleMsg, setRuleMsg] = useState<string | null>(null);
  const router = useRouter();

  const canAnalyze = gmail.connected && gmail.canRead;

  function run() {
    setSummary(null);
    start(async () => {
      const res = await runVoiceAnalysis();
      setSummary(res);
      router.refresh();
    });
  }

  function accept(ruleId: string) {
    if (!profile) return;
    setRuleMsg(null);
    start(async () => {
      const res = await acceptSuggestedRule(profile.id, ruleId);
      if (res.error) setRuleMsg(res.error);
      router.refresh();
    });
  }

  function acceptAll() {
    if (!profile) return;
    setRuleMsg(null);
    start(async () => {
      const res = await acceptAllSuggestedRules(profile.id);
      setRuleMsg(
        res.error
          ? res.error
          : `Accepted ${res.accepted} rule${res.accepted === 1 ? "" : "s"} into Tailoring.`,
      );
      router.refresh();
    });
  }

  const pendingRules = (profile?.suggested_rules ?? []).filter((r) => !r.accepted);

  return (
    <div className="space-y-5">
      {/* Connection + run controls */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        {!gmail.connected ? (
          <div className="space-y-2">
            <p className="text-sm text-zinc-700">
              Connect the Gmail account that holds Jeff&apos;s outreach history
              (read-only) to analyze it.
            </p>
            <a
              href="/api/gmail/connect"
              className="inline-block rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Connect Gmail
            </a>
          </div>
        ) : !gmail.canRead ? (
          <div className="space-y-2">
            <p className="text-sm text-amber-700">
              Gmail is connected{gmail.email ? ` as ${gmail.email}` : ""}, but
              read access hasn&apos;t been granted. Reconnect and allow read-only
              access so the archive can be analyzed.
            </p>
            <a
              href="/api/gmail/connect"
              className="inline-block rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Reconnect with read access
            </a>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={run}
              disabled={pending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {pending
                ? "Analyzing…"
                : profile
                  ? "Re-analyze (new mail only)"
                  : "Run analysis"}
            </button>
            <span className="text-xs text-zinc-500">
              Connected{gmail.email ? ` as ${gmail.email}` : ""} · read-only
            </span>
            {pending && (
              <span className="text-sm text-zinc-500">
                Fetching mail and running multi-pass analysis — this can take a
                few minutes.
              </span>
            )}
          </div>
        )}
      </div>

      {/* Run summary */}
      {summary && (
        <div
          className={`rounded-lg border p-4 text-sm ${
            summary.error
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {summary.error ? (
            summary.error
          ) : summary.nothingNew ? (
            "No new messages since the last run — nothing to do."
          ) : (
            <>
              Analysis complete (v{summary.version}). Processed{" "}
              {summary.newMessages} new message
              {summary.newMessages === 1 ? "" : "s"} ·{" "}
              {summary.insightsCount} insights · {summary.suggestedRulesCount}{" "}
              suggested rules.
            </>
          )}
        </div>
      )}

      {/* Profile status */}
      {profile && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600">
          <span>
            Profile <span className="font-medium text-zinc-900">v{profile.version}</span>
          </span>
          <span>
            Built from{" "}
            <span className="font-medium text-zinc-900">
              {profile.source_message_count}
            </span>{" "}
            messages
          </span>
          <span>Last run {formatDate(profile.created_at)}</span>
        </div>
      )}

      {/* Empty state */}
      {!profile ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center">
          <p className="text-sm text-zinc-500">
            No analysis yet. Connect the account and run analysis to teach the
            app Jeff&apos;s voice.
          </p>
        </div>
      ) : (
        <>
          {/* Insights */}
          <div className="grid gap-4 md:grid-cols-2">
            {CATEGORIES.map((cat) => {
              const summaryText = cat.summaryOf(profile);
              const items = insights.filter((i) => i.category === cat.key);
              return (
                <section
                  key={cat.key}
                  className="rounded-lg border border-zinc-200 bg-white p-4"
                >
                  <h3 className="text-sm font-semibold text-zinc-900">
                    {cat.label}
                  </h3>
                  {summaryText && (
                    <p className="mt-1 text-sm text-zinc-600">{summaryText}</p>
                  )}
                  {items.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {items.map((i) => (
                        <li key={i.id} className="text-sm">
                          <span className="text-zinc-800">• {i.insight}</span>
                          {i.example_excerpt && (
                            <span className="mt-0.5 block border-l-2 border-zinc-200 pl-2 text-xs italic text-zinc-500">
                              &ldquo;{i.example_excerpt}&rdquo;
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>

          {/* Prompt injection preview */}
          {profile.prompt_injection && (
            <section className="rounded-lg border border-zinc-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-zinc-900">
                Draft-engine injection
              </h3>
              <p className="mt-0.5 text-xs text-zinc-400">
                This block is added to every outreach generation so drafts sound
                like Jeff.
              </p>
              <pre className="mt-2 whitespace-pre-wrap rounded bg-zinc-50 p-3 font-sans text-sm text-zinc-700">
                {profile.prompt_injection}
              </pre>
            </section>
          )}

          {/* Suggested rules */}
          <section className="rounded-lg border border-zinc-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900">
                Suggested tailoring rules
              </h3>
              {pendingRules.length > 0 && (
                <button
                  onClick={acceptAll}
                  disabled={pending}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                >
                  Accept all
                </button>
              )}
            </div>
            {ruleMsg && (
              <p className="mt-2 text-sm text-emerald-700">{ruleMsg}</p>
            )}
            {profile.suggested_rules.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-400">
                No suggested rules from this run.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {profile.suggested_rules.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-start justify-between gap-3 rounded-md border border-zinc-100 p-2"
                  >
                    <div>
                      <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
                        {r.rule_type}
                      </span>
                      <p className="mt-1 text-sm text-zinc-800">
                        {r.raw_instruction}
                      </p>
                    </div>
                    {r.accepted ? (
                      <span className="shrink-0 text-xs font-medium text-emerald-600">
                        ✓ Accepted
                      </span>
                    ) : (
                      <button
                        onClick={() => accept(r.id)}
                        disabled={pending}
                        className="shrink-0 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60"
                      >
                        Accept
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
