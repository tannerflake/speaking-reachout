import { SPEAKER_PROFILE, generateText } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import { copyStyleInstructions, enforceStyle } from "@/lib/claude/style";
import type { Contact, Lead, TailoringRule } from "@/lib/types";

/**
 * Per-step guidance. Each follow-up has a distinct job so the sequence reads
 * like a person checking back in, not a drip campaign repeating itself.
 */
const STEP_BRIEFS: Record<number, string> = {
  1: `This is the FIRST follow-up, a few days after the original. Job: a light, friendly bump that makes it easy to answer. 2-4 sentences. Acknowledge inboxes are busy without apologizing for existing. Restate the ask in one plain line (a quick call or a pointer to the right person). You may name ONE concrete talk topic from the original as a reminder of the angle. Do not re-pitch the whole thing and do not add any new facts.`,
  2: `This is the SECOND follow-up, about a week after the first. Job: add one small new reason to reply rather than just nudging again. Pick ONE: a different talk angle from the original that fits their audience, a note on timing flexibility (e.g. a semester or season that might suit them), or a concrete low-friction question such as who handles speaker selection. 3-5 sentences, conversational. Reference the original only in passing ("my note a couple weeks back"). Do not repeat the first follow-up's wording.`,
  3: `This is the THIRD and FINAL follow-up, roughly three weeks after the original. Job: a graceful, pressure-free close that leaves the door open. 2-3 sentences. Say plainly you'll stop here so as not to clutter their inbox, note that the offer stands if timing is better later (next term, next year's program), and sign off warmly. No guilt, no "last chance" language, no hard sell.`,
};

const SYSTEM_BASE = `You write short follow-up emails on behalf of the team that books speaking engagements for the speaker below. The follow-up is a reply in the SAME email thread as an outreach email that got no response, so the original is already visible under it. Write in the first person plural where natural ("we", "Jeff would be glad to"), matching the voice of the original.

${SPEAKER_PROFILE}

The follow-up MUST read like a real person typed it in a couple of minutes, not like marketing automation:
- Plain prose only. No bullet points, no bold, no headings, no emoji, no links unless one appeared in the original and is directly relevant.
- Short. Shorter than the original by a wide margin.
- Specific to this organization: mention them by name or by a detail from the original email. Never invent new facts about them; only reuse what the original already said.
- Vary the opener. Never open with "Just following up", "Just checking in", "Circling back", "Bumping this", "I wanted to follow up", or "Per my last email". Natural openers are fine ("Hi Maria,", then straight into it).
- No apologies for following up and no "I know you're busy" cliches. Small, natural imperfections of a human writer are fine (a sentence fragment, a casual aside); robotic polish is not.
- Close with a simple sign-off and the sender's first name only if the original used one; otherwise a plain sign-off like "Best," or "Thanks," with no signature block (Gmail adds nothing; keep it minimal).
- Do not restate the subject line. Do not quote the original email; the mail client shows it.

Output format: return ONLY a JSON object (no prose, no markdown fences):
{ "body": string }`;

export interface GeneratedFollowup {
  body: string;
  styleAdjusted: boolean;
}

export async function generateFollowup(params: {
  lead: Lead;
  contact: Contact | null;
  step: number;
  original: { subject: string; body: string; sentAt: string | null };
  /** Bodies of earlier follow-ups in this thread, oldest first. */
  priorFollowups: string[];
  rules: TailoringRule[];
  voiceInjection?: string | null;
}): Promise<GeneratedFollowup> {
  const { lead, contact, step, original, priorFollowups, rules, voiceInjection } =
    params;

  const voiceBlock = voiceInjection
    ? `\n\n--- Jeff's learned voice & proven tactics (distilled from his real email history) ---\n${voiceInjection}\n--- end learned voice ---\nIf any operator style rule below conflicts with this learned voice, the operator rule wins.\n`
    : "";
  const system = SYSTEM_BASE + voiceBlock + copyStyleInstructions(rules);

  const brief = STEP_BRIEFS[step] ?? STEP_BRIEFS[3];
  const greetingName = contact?.name?.trim().split(/\s+/)[0] ?? null;
  const prior = priorFollowups.length
    ? `\n\nEarlier follow-ups already sent in this thread (do NOT repeat their wording or angle):\n${priorFollowups
        .map((b, i) => `--- follow-up ${i + 1} ---\n${b}`)
        .join("\n")}`
    : "";

  const userPrompt = `Write follow-up number ${step} for this thread.

${brief}

Organization: ${lead.name} (${lead.type})
Recipient: ${contact?.name ?? "(name unknown)"}${contact?.role ? `, ${contact.role}` : ""}${
    greetingName ? ` — greet them as "${greetingName}"` : " — use a greeting without a name"
  }
Original email sent ${original.sentAt ? new Date(original.sentAt).toDateString() : "recently"}:
Subject: ${original.subject}
${original.body}${prior}

Return the JSON { body }.`;

  const text = await generateText({
    system,
    userPrompt,
    maxTokens: 1200,
    feature: "followup",
  });

  let body: string;
  try {
    const parsed = extractJson<{ body?: unknown }>(text);
    body = typeof parsed.body === "string" ? parsed.body.trim() : text.trim();
  } catch {
    body = text.trim();
  }

  const styled = enforceStyle(body, rules);
  return { body: styled.text, styleAdjusted: styled.changed };
}
