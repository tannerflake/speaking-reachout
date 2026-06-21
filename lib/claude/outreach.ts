import { SPEAKER_PROFILE, generateWithWebSearch } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import { copyStyleInstructions, enforceStyle } from "@/lib/claude/style";
import type { Contact, Lead, TailoringRule } from "@/lib/types";

const OUTREACH_SYSTEM_BASE = `You write a single, specifically-researched outreach email pitching the speaker below for a paid speaking engagement at a given institution or event. You are writing on behalf of the speaker's representative (their family/team handles booking), so write in the first person plural where natural ("we'd love to", "Jeff would be glad to").

${SPEAKER_PROFILE}

Use the web_search tool to find current, specific, verifiable details about the target org/event so the email is clearly researched and not boilerplate.

The email MUST:
- Reference something real and current about the institution/event (a recent theme, initiative, program, anniversary, or stated mission). Do NOT fabricate facts — if web search turns up nothing usable, say so plainly in the body rather than inventing details.
- Propose 1-3 concrete talk topics tailored to that audience.
- Make a genuine, specific case for why Jeff Flake is the right speaker for THIS venue (tie his background to their audience/mission).
- Optionally include 1-2 relevant links (an article, talk, or story) that support the pitch.
- Be appropriately concise and professional; ready to send with light editing.
- Open with an appropriate greeting (use the contact's name if provided) and close with a clear, low-friction ask for a call or reply.

Output format — return ONLY a JSON object (no prose, no markdown fences):
{ "subject": string, "body": string }`;

export interface GeneratedOutreach {
  subject: string;
  body: string;
  styleAdjusted: boolean;
}

export async function generateOutreach(params: {
  lead: Lead;
  contact: Contact | null;
  rules: TailoringRule[];
  oneOffInstruction?: string;
  /** Active voice_profile.prompt_injection (Voice & Insights feature). */
  voiceInjection?: string | null;
}): Promise<GeneratedOutreach> {
  const { lead, contact, rules, oneOffInstruction, voiceInjection } = params;

  // Learned voice goes first; operator style rules come after and win on
  // conflict (Section 6 precedence: stated wishes beat inferred patterns).
  const voiceBlock = voiceInjection
    ? `\n\n--- Jeff's learned voice & proven tactics (distilled from his real email history) ---\n${voiceInjection}\n--- end learned voice ---\nIf any operator style rule below conflicts with this learned voice, the operator rule wins.\n`
    : "";

  const system =
    OUTREACH_SYSTEM_BASE + voiceBlock + copyStyleInstructions(rules);

  const contactLine = contact
    ? `Contact: ${contact.name ?? "(name unknown)"}${
        contact.role ? `, ${contact.role}` : ""
      }${contact.email ? ` <${contact.email}>` : " (email not yet resolved)"}.`
    : "Contact: none resolved yet — address it to the relevant team/role generically.";

  const topics = lead.suggested_topics?.length
    ? lead.suggested_topics.join("; ")
    : "(none pre-suggested — propose your own)";

  const userPrompt = `Write outreach for this lead.

Name: ${lead.name}
Type: ${lead.type}
Description: ${lead.description ?? "(none)"}
Location: ${[lead.location_region, lead.location_country].filter(Boolean).join(", ") || "(unknown)"}
Website: ${lead.website ?? "(unknown)"}
Why it's a fit (our earlier note): ${lead.fit_rationale ?? "(none)"}
Pre-suggested topics: ${topics}
${contactLine}${
    oneOffInstruction
      ? `\n\nOne-off instruction for THIS draft only: ${oneOffInstruction}`
      : ""
  }

Research the org/event with web search, then return the JSON { subject, body }.`;

  const text = await generateWithWebSearch({
    system,
    userPrompt,
    maxTokens: 8000,
    maxSearches: 6,
  });

  let parsed: { subject?: unknown; body?: unknown };
  try {
    parsed = extractJson<{ subject?: unknown; body?: unknown }>(text);
  } catch {
    // Fall back to treating the whole output as the body with a generic subject.
    parsed = { subject: `Speaking opportunity — ${lead.name}`, body: text };
  }

  const rawSubject =
    typeof parsed.subject === "string" && parsed.subject.trim()
      ? parsed.subject.trim()
      : `Speaking opportunity with Jeff Flake — ${lead.name}`;
  const rawBody =
    typeof parsed.body === "string" ? parsed.body.trim() : text.trim();

  // Hard style enforcement (Section 6/7): strip/rewrite violations.
  const subj = enforceStyle(rawSubject, rules);
  const body = enforceStyle(rawBody, rules);

  return {
    subject: subj.text,
    body: body.text,
    styleAdjusted: subj.changed || body.changed,
  };
}
