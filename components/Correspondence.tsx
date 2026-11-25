import { InboxChip } from "@/components/Badge";
import type { LeadMessage } from "@/lib/types";

export function phoenixDateTime(value: string | null): string {
  if (!value) return "—";
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

/** "bot:Jeff's bot" -> "Jeff's bot"; other actors as stored. */
export function actorLabel(actor: string | null | undefined): string | null {
  if (!actor) return null;
  if (actor.startsWith("bot:")) return actor.slice(4) || "Bot";
  if (actor === "user" || actor === "system") return null;
  return actor;
}

/**
 * Imported correspondence (lead_messages) for a lead, oldest first: direction,
 * from, to, date (Arizona time), subject, snippet that expands to the body,
 * and the inbox it came from.
 */
export function Correspondence({ messages }: { messages: LeadMessage[] }) {
  if (messages.length === 0) return null;
  return (
    <ol className="space-y-2">
      {messages.map((m) => {
        const inbound = m.direction === "inbound";
        const preview = m.snippet || (m.body ? m.body.replace(/\s+/g, " ").slice(0, 240) : "");
        return (
          <li
            key={m.id}
            className={`rounded-md border p-3 text-sm ${
              inbound ? "border-emerald-200 bg-white" : "border-zinc-200 bg-zinc-50"
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <span
                  className={`mr-1.5 font-semibold ${inbound ? "text-emerald-700" : "text-zinc-500"}`}
                  title={inbound ? "Received" : "Sent"}
                  aria-label={inbound ? "Received" : "Sent"}
                >
                  {inbound ? "↙" : "↗"}
                </span>
                <span className="font-medium text-zinc-800">{m.from_name || m.from_email}</span>
                {m.from_name && <span className="ml-1 text-xs text-zinc-500">{m.from_email}</span>}
                <span className="ml-1 text-xs text-zinc-500">
                  to {m.to_emails.join(", ") || "—"}
                  {m.cc_emails.length > 0 ? ` (cc ${m.cc_emails.join(", ")})` : ""}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <InboxChip inbox={m.source_inbox} />
                <span className="text-xs text-zinc-400">{phoenixDateTime(m.sent_at)}</span>
              </div>
            </div>
            <div className="mt-1 font-medium text-zinc-700">{m.subject || "(no subject)"}</div>
            {m.body && m.body.trim() !== preview.trim() ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-zinc-600">{preview}</summary>
                <p className="mt-2 whitespace-pre-wrap text-zinc-700">{m.body}</p>
              </details>
            ) : (
              preview && <p className="mt-1 text-zinc-600">{preview}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
