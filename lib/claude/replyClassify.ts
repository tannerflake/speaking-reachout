import { getAnthropic, extractText } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import { addUsage, emptyUsage, recordUsage } from "@/lib/claude/usage";

// Cheap model for a short, high-volume-but-rare classification. Replies to cold
// outreach are infrequent, so this only fires a handful of times per scan and
// keeps token spend negligible. Haiku 5.5 ($0.10/$0.50 per MTok) replaced
// Haiku 4.5 ($1/$5) on 2026-10-13.
const CLASSIFY_MODEL = "claude-haiku-5-5";

export type ReplyClassification =
  | "interested"
  | "not_interested"
  | "cant_pay"
  | "auto_reply"
  | "unrelated";

export interface ClassifiedReply {
  classification: ReplyClassification;
  /** One-line, plain-English summary of the reply, for the activity log. */
  note: string;
}

const SYSTEM = `You classify a single email reply received in response to a cold speaking-engagement outreach sent on behalf of speaker Jeff Flake (former U.S. Senator). Decide the sender's intent and write a one-line note.

Categories:
- "interested": the sender is open or positive — wants to talk, asks for details/availability/fee/topics, forwards to a colleague, or otherwise engages constructively.
- "cant_pay": the sender is otherwise open but cannot or will not pay an honorarium / speaking fee — no budget for speakers, can only offer travel or an unpaid slot, the fee is too high, or they ask Jeff to waive it. Use this whenever money is the stated reason the conversation ends.
- "not_interested": the sender declines for any other reason — says no, not a fit, wrong timing, asks to be removed, or unsubscribes.
- "auto_reply": an automated message not written by a human deciding on the pitch — out-of-office, vacation autoresponder, "I'll be back on...", receipt/ticket confirmations, or delivery/mailer-daemon notices.
- "unrelated": the message is not a response to the outreach at all — a newsletter, event announcement, mass mailing, or an unrelated conversation. Only use this when the message arrived OUTSIDE the original outreach thread and clearly has nothing to do with the pitch.

Return ONLY a JSON object (no prose, no markdown fences):
{ "classification": "interested" | "not_interested" | "cant_pay" | "auto_reply" | "unrelated", "note": string }

The note must be a concise summary (max ~140 characters) of what the reply actually says.`;

/**
 * Classify one inbound reply. Best-effort: on any parse/model failure we fall
 * back to "interested" so a real lead surfaces for the operator rather than
 * being silently dropped.
 */
export async function classifyReply(input: {
  leadName: string;
  from: string;
  subject: string;
  body: string;
  /** False when matched by sender/domain rather than the outreach thread. */
  inOriginalThread?: boolean;
}): Promise<ClassifiedReply> {
  const client = getAnthropic();

  // Truncate the body — the intent is almost always clear in the opening lines,
  // and this caps token use per reply.
  const body = input.body.slice(0, 1500);
  const where =
    input.inOriginalThread === false
      ? "Arrived in a SEPARATE thread from someone at the same organization (may or may not be about the pitch)."
      : "Arrived as a reply in the original outreach thread.";
  const userPrompt = `Lead (the org/event we pitched): ${input.leadName}
${where}
Reply from: ${input.from}
Subject: ${input.subject}

Reply body:
${body || "(empty)"}`;

  const totals = emptyUsage();
  const started = Date.now();
  try {
    const message = await client.messages.create({
      model: CLASSIFY_MODEL,
      // Haiku 5.5 thinks by default and that spends from max_tokens; low
      // effort plus headroom keeps the short JSON from being truncated.
      max_tokens: 1024,
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });
    addUsage(totals, message.usage);
    void recordUsage({
      feature: "classify",
      model: CLASSIFY_MODEL,
      totals,
      durationMs: Date.now() - started,
      ok: true,
    });
    const parsed = extractJson<{ classification?: unknown; note?: unknown }>(
      extractText(message),
    );
    const classification: ReplyClassification =
      parsed.classification === "not_interested" ||
      parsed.classification === "cant_pay" ||
      parsed.classification === "auto_reply" ||
      (parsed.classification === "unrelated" && input.inOriginalThread === false)
        ? parsed.classification
        : "interested";
    const note =
      typeof parsed.note === "string" && parsed.note.trim()
        ? parsed.note.trim().slice(0, 200)
        : "(reply received)";
    return { classification, note };
  } catch (e) {
    void recordUsage({
      feature: "classify",
      model: CLASSIFY_MODEL,
      totals,
      durationMs: Date.now() - started,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    const snippet = body.replace(/\s+/g, " ").trim().slice(0, 140);
    return {
      classification: "interested",
      note: snippet ? `Reply: ${snippet}` : "Reply received.",
    };
  }
}
