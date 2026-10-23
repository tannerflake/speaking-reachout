import { getLeadConversations } from "@/lib/gmail/conversation";
import type { ConversationMessage, ConversationThread } from "@/lib/gmail/conversation";
import { StatusBadge } from "@/components/Badge";
import type { Contact, Interaction, LeadStatus, Outreach } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

const ORIGIN_LABEL: Record<ConversationThread["origin"], string> = {
  outreach: "Reply to our outreach",
  contact: "New thread from a contact",
  domain: "New thread from someone at this organization",
};

function Message({ m }: { m: ConversationMessage }) {
  if (m.isFromUs || m.isAutomated) {
    // Our pitch and auto-replies stay folded so the person's words stand out.
    return (
      <details className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm">
        <summary className="cursor-pointer text-zinc-500">
          <span className="font-medium text-zinc-600">
            {m.isFromUs ? "We wrote" : `Automatic reply from ${m.fromName}`}
          </span>
          <span className="ml-2 text-xs text-zinc-400">{formatDateTime(m.date)}</span>
        </summary>
        <p className="mt-2 whitespace-pre-wrap text-zinc-600">{m.body}</p>
      </details>
    );
  }
  return (
    <div className="rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-semibold text-zinc-900">{m.fromName}</span>
          {m.contactRole && <span className="text-zinc-500"> · {m.contactRole}</span>}
          <a
            href={`mailto:${m.fromEmail}`}
            className="ml-2 text-xs text-blue-600 hover:underline"
          >
            {m.fromEmail}
          </a>
        </div>
        <span className="text-xs text-zinc-400">{formatDateTime(m.date)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-zinc-800">{m.body || "(no text)"}</p>
    </div>
  );
}

/**
 * Top-of-page view of every conversation where someone at the organization
 * wrote back, read live from Gmail so nobody has to search the inbox. Shows
 * nothing when no one has replied.
 */
export async function ReplyThreads({
  lead,
  interactions,
}: {
  lead: {
    status: LeadStatus;
    website: string | null;
    contacts: Contact[];
    outreach: Outreach[];
  };
  interactions: Interaction[];
}) {
  const result = await getLeadConversations(lead);
  // What the reply scanner concluded about each reply, newest first.
  const verdicts = interactions.filter((i) => i.detail?.startsWith("Reply from "));

  if (result.kind === "unavailable") {
    if (verdicts.length === 0) return null;
    return (
      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <h2 className="font-semibold">Someone replied</h2>
        <p className="mt-1">Couldn&apos;t load the conversation from Gmail: {result.error}</p>
        <ul className="mt-2 space-y-1">
          {verdicts.map((v) => (
            <li key={v.id}>{v.detail}</li>
          ))}
        </ul>
      </section>
    );
  }
  if (result.threads.length === 0) {
    // The scanner logged a reply, but the thread isn't in this mailbox any
    // more (often moved to another inbox when someone was added to it).
    if (verdicts.length === 0) return null;
    return (
      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <h2 className="font-semibold">Someone replied</h2>
        <p className="mt-1">
          The conversation isn&apos;t in {result.mailbox ?? "the connected mailbox"}{" "}
          any more, so it may have moved to another inbox. What the scan recorded:
        </p>
        <ul className="mt-2 space-y-1">
          {verdicts.map((v) => (
            <li key={v.id}>{v.detail}</li>
          ))}
        </ul>
      </section>
    );
  }

  const people = new Set(
    result.threads.flatMap((t) =>
      t.messages.filter((m) => !m.isFromUs && !m.isAutomated).map((m) => m.fromName),
    ),
  );

  return (
    <section className="rounded-lg border-2 border-emerald-300 bg-emerald-50/50 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold text-zinc-900">
          {[...people].join(", ")} replied
        </h2>
        <StatusBadge status={lead.status} />
      </div>
      {verdicts.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-zinc-700">
          {verdicts.map((v) => (
            <li key={v.id}>
              <span className="text-xs font-medium uppercase tracking-wide text-emerald-700">
                Summary
              </span>{" "}
              {v.detail?.replace(/ Follow-ups to everyone at this organization stopped\./, "")}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 space-y-5">
        {result.threads.map((t) => (
          <div key={t.threadId}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-zinc-900">{t.subject}</div>
                <div className="text-xs text-zinc-500">{ORIGIN_LABEL[t.origin]}</div>
              </div>
              <a
                href={t.gmailUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Open in Gmail ↗
              </a>
            </div>
            <div className="space-y-2">
              {t.messages.map((m) => (
                <Message key={m.id} m={m} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
