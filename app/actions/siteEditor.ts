"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUser } from "@/lib/auth/profile";
import { getRawContentForSections } from "@/lib/site/content";
import {
  proposeSiteEdit,
  validateAndSanitizeOps,
  type PreviewItem,
  type SiteEditOp,
} from "@/lib/claude/siteEditor";
import { EDITABLE_SECTION_KEYS } from "@/lib/site/types";
import { hasEmDash } from "@/lib/site/sanitize";
import { clampOffset, clampZoom } from "@/lib/site/images";

const SITE_IMAGES_BUCKET = "site-images";

export interface ProposeResult {
  ok: boolean;
  error?: string;
  ops?: SiteEditOp[];
  preview?: PreviewItem[];
  summary?: string;
}

/** Step 1: parse a plain-language request into a validated structured diff. */
export async function proposeChange(requestText: string): Promise<ProposeResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Not authorized." };

  const text = requestText.trim();
  if (!text) return { ok: false, error: "Describe the change you want to make." };

  try {
    const rows = await getRawContentForSections([...EDITABLE_SECTION_KEYS]);
    const { ops: rawOps, summary } = await proposeSiteEdit({
      requestText: text,
      rows,
    });
    const { ops, preview } = validateAndSanitizeOps(rawOps, rows);

    if (ops.length === 0) {
      return {
        ok: true,
        ops: [],
        preview: [],
        summary:
          summary || "No safe change could be derived from that request.",
      };
    }
    return { ok: true, ops, preview, summary };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to propose a change.",
    };
  }
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  applied?: number;
}

/**
 * Step 3: apply a previously proposed diff. Re-validates the ops against live
 * data (never trusts the client), enforces the delete-confirmation guard,
 * writes the changes, logs to edit_log, and revalidates the public pages.
 */
export async function applyChange(
  clientOps: SiteEditOp[],
  requestText: string,
  confirmDelete: boolean,
): Promise<ApplyResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Not authorized." };
  if (!Array.isArray(clientOps) || clientOps.length === 0) {
    return { ok: false, error: "Nothing to apply." };
  }

  const supabase = await createClient();
  const rows = await getRawContentForSections([...EDITABLE_SECTION_KEYS]);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Re-validate the ops the client sent against current data. This is the
  // security boundary; anything tampered with is dropped here.
  const { ops } = validateAndSanitizeOps(clientOps, rows);
  if (ops.length === 0) {
    return { ok: false, error: "These changes are no longer valid. Re-propose." };
  }

  const hasDelete = ops.some((o) => o.op === "delete");
  if (hasDelete && !confirmDelete) {
    return { ok: false, error: "Deletions need explicit confirmation." };
  }

  let applied = 0;
  for (const op of ops) {
    if (op.op === "create") {
      // Default sort_order to end-of-section when not specified.
      let sort = op.sort_order;
      if (typeof sort !== "number") {
        const max = rows
          .filter((r) => r.section_key === op.section_key)
          .reduce((m, r) => Math.max(m, r.sort_order), 0);
        sort = max + 1;
      }
      const { error } = await supabase.from("site_content").insert({
        section_key: op.section_key,
        sort_order: sort,
        data: op.data ?? {},
        is_published: true,
      });
      if (!error) applied += 1;
    } else if (op.op === "update" && op.id) {
      const existing = byId.get(op.id);
      const merged = { ...(existing?.data ?? {}), ...(op.data ?? {}) };
      const { error } = await supabase
        .from("site_content")
        .update({ data: merged })
        .eq("id", op.id);
      if (!error) applied += 1;
    } else if (op.op === "reorder" && op.id && typeof op.sort_order === "number") {
      const { error } = await supabase
        .from("site_content")
        .update({ sort_order: op.sort_order })
        .eq("id", op.id);
      if (!error) applied += 1;
    } else if (op.op === "delete" && op.id) {
      const { error } = await supabase
        .from("site_content")
        .delete()
        .eq("id", op.id);
      if (!error) applied += 1;
    }
  }

  // Audit log for safety/rollback.
  await supabase.from("edit_log").insert({
    user_email: me.email,
    request_text: requestText,
    diff: ops,
  });

  // Bust any route cache so edits show up immediately.
  revalidatePath("/");
  revalidatePath("/bio");
  revalidatePath("/media");

  return { ok: true, applied };
}

export interface UploadResult {
  ok: boolean;
  error?: string;
  image_key?: string;
}

/**
 * Upload an image to Supabase Storage and register/refresh its image_key.
 * A human always assigns the key; the AI can only reference existing keys.
 */
export async function uploadSiteImage(formData: FormData): Promise<UploadResult> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Not authorized." };

  const file = formData.get("file");
  const imageKey = String(formData.get("image_key") ?? "").trim();
  const altText = String(formData.get("alt_text") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const offsetX = clampOffset(Number(formData.get("offset_x")));
  const offsetY = clampOffset(Number(formData.get("offset_y")));
  const zoom = clampZoom(Number(formData.get("zoom")));

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose an image file." };
  }
  if (!/^[a-z0-9_]+$/.test(imageKey)) {
    return {
      ok: false,
      error: "Image key must be lowercase letters, numbers, and underscores.",
    };
  }
  if (altText && hasEmDash(altText)) {
    return { ok: false, error: "Alt text cannot contain em dashes." };
  }

  const admin = createAdminClient();

  // Ensure the public bucket exists (no-op if already created).
  await admin.storage.createBucket(SITE_IMAGES_BUCKET, { public: true }).catch(() => {});

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
  const path = `${imageKey}/${Date.now()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadError } = await admin.storage
    .from(SITE_IMAGES_BUCKET)
    .upload(path, bytes, { contentType: file.type, upsert: true });
  if (uploadError) {
    return { ok: false, error: `Upload failed: ${uploadError.message}` };
  }

  const baseRow = {
    image_key: imageKey,
    storage_path: path,
    alt_text: altText || imageKey,
    subject: subject || null,
  };

  let { error: rowError } = await admin
    .from("site_images")
    .upsert(
      { ...baseRow, offset_x: offsetX, offset_y: offsetY, zoom },
      { onConflict: "image_key" },
    );
  // The offset_x/offset_y/zoom columns ship in migration 0005. If it has not
  // been applied yet, retry without them so the upload still succeeds (the
  // framing simply won't persist until the migration runs).
  if (rowError) {
    ({ error: rowError } = await admin
      .from("site_images")
      .upsert(baseRow, { onConflict: "image_key" }));
  }
  if (rowError) {
    return { ok: false, error: `Could not register image: ${rowError.message}` };
  }

  revalidatePath("/");
  return { ok: true, image_key: imageKey };
}
