import { readFile } from "node:fs/promises";
import path from "node:path";

/** A file to attach to an outgoing Gmail message. */
export interface EmailAttachment {
  /** Filename the recipient sees. */
  filename: string;
  mimeType: string;
  content: Buffer;
}

/**
 * The one-page speaking overview (topics + prior engagements) that goes out
 * with every INITIAL outreach email. Follow-ups and notifications never
 * attach it.
 *
 * To update it: replace the file at this path with the new one-pager, keeping
 * the same filename, and deploy. The display name below is what recipients see.
 */
const ONE_PAGER_PATH = path.join(
  process.cwd(),
  "assets",
  "outreach",
  "ambassador-jeff-flake-speaking-guide.pdf",
);
const ONE_PAGER_DISPLAY_NAME = "Ambassador Jeff Flake Speaking Guide.pdf";

let cached: Promise<EmailAttachment> | null = null;

export function getOutreachOnePager(): Promise<EmailAttachment> {
  if (!cached) {
    cached = readFile(ONE_PAGER_PATH)
      .then((content) => ({
        filename: ONE_PAGER_DISPLAY_NAME,
        mimeType: "application/pdf",
        content,
      }))
      .catch((e) => {
        // Don't cache a failure (a later deploy or disk fix may resolve it).
        cached = null;
        throw new Error(
          `Could not read the outreach one-pager at ${ONE_PAGER_PATH}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      });
  }
  return cached;
}
