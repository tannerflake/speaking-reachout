import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUser } from "@/lib/auth/profile";
import { BotKeyActions, RevokeKeyButton } from "@/components/BotAccessManager";
import type { BotActivity } from "@/lib/types";

export const dynamic = "force-dynamic";

const BASE_URL = "https://www.jeffflake.com/api/bot/v1";

function phoenix(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: "America/Phoenix",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface KeyRow {
  id: string;
  label: string;
  key_prefix: string | null;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

const ENDPOINTS = [
  "GET  /me",
  "GET  /leads/search?domain=&email=&name=&q=&limit=",
  "GET  /leads/:id[?bodies=1]",
  "POST /leads/upsert",
  "POST /leads/:id/messages",
  "POST /leads/:id/status",
  "GET  /leads/:id/engagements",
  "POST /leads/:id/engagements",
  "GET  /engagements?year=&outcome=",
];

/**
 * Settings > Bot access: API keys for Jeff's grooming bot and its recent
 * activity. Keys are hashed at rest; the hash is never selected here.
 */
export default async function BotAccessPage() {
  const me = await getCurrentUser();
  if (!me || me.role !== "crm_admin") {
    return <p className="text-sm text-zinc-500">Only CRM admins can manage bot access.</p>;
  }
  const db = createAdminClient();
  const [keysRes, actRes] = await Promise.all([
    db
      .from("bot_api_keys")
      .select("id, label, key_prefix, created_at, created_by, last_used_at, revoked_at")
      .order("created_at", { ascending: false }),
    db
      .from("bot_activity")
      .select("*, lead:leads(name)")
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  const unavailable = keysRes.error || actRes.error;
  const keys = (keysRes.data ?? []) as KeyRow[];
  const active = keys.filter((k) => !k.revoked_at);
  const revoked = keys.filter((k) => k.revoked_at);
  const activity = (actRes.data ?? []) as Array<BotActivity & { lead: { name: string } | null }>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Bot access</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Keys for Jeff&apos;s grooming bot to add and update leads, log correspondence from
          any inbox, and record engagements. The bot never sends, queues or drafts email
          and never starts follow-ups. Base URL{" "}
          <code className="rounded bg-zinc-100 px-1 font-mono text-xs">{BASE_URL}</code>, header{" "}
          <code className="rounded bg-zinc-100 px-1 font-mono text-xs">Authorization: Bearer jfb_…</code>{" "}
          (optional <code className="rounded bg-zinc-100 px-1 font-mono text-xs">X-Bot-Name</code>). Full
          reference: <code className="font-mono text-xs">docs/bot-api.md</code> in the repo.
        </p>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-zinc-600">Endpoints</summary>
          <pre className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
            {ENDPOINTS.join("\n")}
          </pre>
        </details>
      </div>

      {unavailable && (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          Could not read bot tables: {keysRes.error?.message ?? actRes.error?.message}. Is migration 0037 applied?
        </p>
      )}

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-500">Keys</h2>
        <BotKeyActions hasActive={active.length > 0} />
        {active.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-500">No active keys.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs font-medium text-zinc-500">
              <tr>
                <th className="py-1.5 pr-3">Label</th>
                <th className="py-1.5 pr-3">Key</th>
                <th className="py-1.5 pr-3">Created</th>
                <th className="py-1.5 pr-3">Last used</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {active.map((k) => (
                <tr key={k.id}>
                  <td className="py-2 pr-3 font-medium text-zinc-800">{k.label}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-zinc-600">{k.key_prefix ?? "jfb_"}…</td>
                  <td className="py-2 pr-3 text-zinc-600">
                    {phoenix(k.created_at)}
                    {k.created_by ? <span className="text-xs text-zinc-400"> by {k.created_by}</span> : null}
                  </td>
                  <td className="py-2 pr-3 text-zinc-600">{phoenix(k.last_used_at)}</td>
                  <td className="py-2 text-right">
                    <RevokeKeyButton id={k.id} label={k.label} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {revoked.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-zinc-500">Revoked keys ({revoked.length})</summary>
            <ul className="mt-2 space-y-1 text-xs text-zinc-500">
              {revoked.map((k) => (
                <li key={k.id}>
                  {k.label} · <span className="font-mono">{k.key_prefix ?? "jfb_"}…</span> · created{" "}
                  {phoenix(k.created_at)} · revoked {phoenix(k.revoked_at)} · last used {phoenix(k.last_used_at)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-500">Recent bot activity (last 50, Arizona time)</h2>
        {activity.length === 0 ? (
          <p className="text-sm text-zinc-500">No bot activity yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 text-xs font-medium text-zinc-500">
                <tr>
                  <th className="py-1.5 pr-3">Time</th>
                  <th className="py-1.5 pr-3">Bot</th>
                  <th className="py-1.5 pr-3">Request</th>
                  <th className="py-1.5 pr-3">Lead</th>
                  <th className="py-1.5 pr-3">Inbox</th>
                  <th className="py-1.5 pr-3">Summary</th>
                  <th className="py-1.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 align-top">
                {activity.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap py-2 pr-3 text-zinc-500">{phoenix(a.created_at)}</td>
                    <td className="py-2 pr-3 text-zinc-700">{a.bot_name ?? "—"}</td>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-zinc-600">
                      {a.method} {a.endpoint?.replace("/api/bot/v1", "")}
                    </td>
                    <td className="py-2 pr-3">
                      {a.lead_id ? (
                        <Link href={`/admin/leads/${a.lead_id}`} className="text-blue-600 hover:underline">
                          {a.lead?.name ?? "Open lead"}
                        </Link>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-zinc-500">{a.source_inbox ?? "—"}</td>
                    <td className="max-w-xl py-2 pr-3 text-xs text-zinc-700">{a.summary ?? ""}</td>
                    <td className="py-2">
                      <span
                        className={`rounded-full border px-1.5 py-0.5 text-xs font-medium ${
                          (a.status_code ?? 0) < 300
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : (a.status_code ?? 0) < 500
                              ? "border-amber-200 bg-amber-50 text-amber-700"
                              : "border-rose-200 bg-rose-50 text-rose-700"
                        }`}
                      >
                        {a.status_code ?? "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
