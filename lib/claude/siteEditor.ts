import { generateText } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import { sanitizeDeep, stripEmDashes } from "@/lib/site/sanitize";
import { EDITABLE_SECTION_KEYS } from "@/lib/site/types";
import type { SectionKey, SiteContentRow } from "@/lib/site/types";

export type EditOpType = "create" | "update" | "reorder" | "delete";

export interface SiteEditOp {
  op: EditOpType;
  section_key: SectionKey;
  /** Existing row id for update/reorder/delete. */
  id?: string;
  /** New/changed payload for create/update. */
  data?: Record<string, unknown>;
  /** Target ordering for create/reorder. */
  sort_order?: number;
  /** Short human-readable description of this single change. */
  summary?: string;
}

export interface PreviewItem {
  type: EditOpType;
  section_key: string;
  label: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  needsConfirm: boolean;
}

// Whitelisted data fields per section. Anything else the model emits is dropped
// before it can reach the store.
const ALLOWED_DATA_KEYS: Record<SectionKey, string[]> = {
  hero: ["kicker", "headline", "subhead", "cta_label", "image_key"],
  story: ["title", "body", "image_key", "stats", "tone"],
  quirk: ["label"],
  topic: ["title", "body"],
  audience_type: ["label"],
  engagement: ["name", "kind"],
  featured_video: [
    "title",
    "caption",
    "video_url",
    "event_url",
    "poster_image_key",
  ],
  media_item: ["title", "outlet", "url"],
  testimonial: ["quote", "attribution"],
  book: ["headline", "body", "fallback_email", "image_key"],
};

function buildSystemPrompt(): string {
  return `You are the content editor for jeffflake.com, a marketing site that books Ambassador Jeff Flake as a speaker. The operator types a plain-language request. You convert it into a precise, structured list of changes to the content store.

The content store is a list of records. Each record has: id, section_key, sort_order, and a data object.

Editable section_key values and their data fields:
- hero (one record): kicker, headline, subhead, cta_label, image_key
- story (ordered beats): title, body, image_key, stats (array of {value, label}), tone ("warm" or "default")
- quirk (ordered chips): label
- topic (ordered, click-to-expand): title, body
- audience_type (ordered chips): label
- engagement (ordered): name, kind ("recent" or "upcoming")
- featured_video (one record): title, caption, video_url, event_url, poster_image_key
- media_item (ordered op-eds/articles): title, outlet, url
- testimonial (ordered): quote, attribution
- book (one record, final CTA): headline, body, fallback_email, image_key

Return ONLY a JSON object, no prose, no markdown fences, shaped exactly:
{
  "ops": [
    { "op": "create"|"update"|"reorder"|"delete", "section_key": "...", "id": "<existing id, for update/reorder/delete>", "data": { ... }, "sort_order": <int, optional>, "summary": "one short sentence" }
  ],
  "summary": "one sentence describing the overall change"
}

Rules:
- For "update", include the id of the record being changed and ONLY the data fields that change.
- For "create", include section_key and the full data. Pick a sort_order that places it sensibly (e.g. end of its section).
- For "delete", include only the id. Use delete only when the request clearly asks to remove something.
- Never invent ids. Only use ids present in the provided records.
- Only ever touch the section_key values listed above. You cannot change layout, structure, code, auth, images themselves, or anything in the CRM.
- Do not assign image_key values that are not referenced in the records unless the request explicitly names an uploaded image key.
- ABSOLUTE RULE: never use em dashes or en dashes in any text. Use commas, periods, or parentheses instead.
- If the request is ambiguous or out of scope, return an empty "ops" array and explain in "summary".`;
}

interface RawProposal {
  ops?: SiteEditOp[];
  summary?: string;
}

/** Ask Claude for a structured diff given the live content rows. */
export async function proposeSiteEdit(opts: {
  requestText: string;
  rows: SiteContentRow[];
}): Promise<{ ops: SiteEditOp[]; summary: string }> {
  const recordsForModel = opts.rows.map((r) => ({
    id: r.id,
    section_key: r.section_key,
    sort_order: r.sort_order,
    data: r.data,
  }));

  const userPrompt = `Current records:\n${JSON.stringify(
    recordsForModel,
    null,
    2,
  )}\n\nOperator request:\n${stripEmDashes(opts.requestText)}`;

  const text = await generateText({
    system: buildSystemPrompt(),
    userPrompt,
    maxTokens: 4096,
  });

  let parsed: RawProposal;
  try {
    parsed = extractJson<RawProposal>(text);
  } catch {
    return { ops: [], summary: "Could not interpret that request. Try rephrasing." };
  }

  return {
    ops: Array.isArray(parsed.ops) ? parsed.ops : [],
    summary: typeof parsed.summary === "string" ? stripEmDashes(parsed.summary) : "",
  };
}

function isEditableSection(key: unknown): key is SectionKey {
  return (
    typeof key === "string" &&
    (EDITABLE_SECTION_KEYS as string[]).includes(key)
  );
}

/** Keep only whitelisted data fields for a section, then strip em dashes. */
function cleanData(
  section: SectionKey,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const allowed = ALLOWED_DATA_KEYS[section];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in data) out[key] = data[key];
  }
  return sanitizeDeep(out);
}

/**
 * Validate the model's ops against the live rows and the whitelist, dropping
 * anything unsafe. Returns clean ops plus a human-readable preview (before /
 * after) for the confirm screen.
 */
export function validateAndSanitizeOps(
  ops: SiteEditOp[],
  rows: SiteContentRow[],
): { ops: SiteEditOp[]; preview: PreviewItem[] } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const clean: SiteEditOp[] = [];
  const preview: PreviewItem[] = [];

  for (const op of ops) {
    if (!isEditableSection(op.section_key)) continue;
    const section = op.section_key;

    if (op.op === "create") {
      const data = cleanData(section, op.data);
      if (Object.keys(data).length === 0) continue;
      clean.push({
        op: "create",
        section_key: section,
        data,
        sort_order: typeof op.sort_order === "number" ? op.sort_order : undefined,
        summary: op.summary,
      });
      preview.push({
        type: "create",
        section_key: section,
        label: op.summary ?? `Add a new ${section}`,
        before: null,
        after: data,
        needsConfirm: false,
      });
      continue;
    }

    // update / reorder / delete all need a valid existing id in this section.
    const existing = op.id ? byId.get(op.id) : undefined;
    if (!existing || !isEditableSection(existing.section_key)) continue;

    if (op.op === "update") {
      const data = cleanData(section, op.data);
      if (Object.keys(data).length === 0) continue;
      const after = { ...existing.data, ...data };
      clean.push({ op: "update", section_key: section, id: op.id, data, summary: op.summary });
      preview.push({
        type: "update",
        section_key: section,
        label: op.summary ?? `Update ${section}`,
        before: existing.data,
        after,
        needsConfirm: false,
      });
    } else if (op.op === "reorder") {
      if (typeof op.sort_order !== "number") continue;
      clean.push({ op: "reorder", section_key: section, id: op.id, sort_order: op.sort_order });
      preview.push({
        type: "reorder",
        section_key: section,
        label: op.summary ?? `Reorder ${section} to position ${op.sort_order}`,
        before: { sort_order: existing.sort_order },
        after: { sort_order: op.sort_order },
        needsConfirm: false,
      });
    } else if (op.op === "delete") {
      clean.push({ op: "delete", section_key: section, id: op.id, summary: op.summary });
      preview.push({
        type: "delete",
        section_key: section,
        label: op.summary ?? `Delete this ${section}`,
        before: existing.data,
        after: null,
        // Destructive ops require an explicit second confirmation.
        needsConfirm: true,
      });
    }
  }

  return { ops: clean, preview };
}
