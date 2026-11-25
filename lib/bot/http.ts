import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authenticateBot, type BotIdentity } from "@/lib/bot/auth";

export type Admin = ReturnType<typeof createAdminClient>;

/** Thrown inside a handler to return a specific status + JSON body. */
export class BotError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
    /** Short text for the bot_activity summary. */
    public summary?: string,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
  }
}

export interface BotContext {
  db: Admin;
  bot: BotIdentity;
  req: NextRequest;
  url: URL;
}

export interface BotResult {
  status?: number;
  body: unknown;
  /** Recorded on the bot_activity row. */
  leadId?: string | null;
  sourceInbox?: string | null;
  summary?: string;
}

/**
 * Wrap a bot API route: bearer auth (401 with no detail on failure), JSON
 * errors (never a stack trace in the body), and one bot_activity row per
 * authenticated request, success or failure.
 */
export function botRoute<P = Record<string, string>>(
  handler: (ctx: BotContext, params: P) => Promise<BotResult>,
) {
  return async (req: NextRequest, segment: { params: Promise<P> }) => {
    let db: Admin;
    try {
      db = createAdminClient();
    } catch {
      return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
    }
    const bot = await authenticateBot(db, req.headers);
    if (!bot) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    let result: BotResult;
    try {
      const params = (await segment?.params) ?? ({} as P);
      result = await handler({ db, bot, req, url }, params);
    } catch (e) {
      if (e instanceof BotError) {
        result = {
          status: e.status,
          body: e.body,
          summary: e.summary ?? `error: ${e.message}`,
          leadId: typeof e.body.lead_id === "string" ? e.body.lead_id : null,
        };
      } else {
        // Message only: no request headers, no body echo.
        console.error(
          `[bot-api] ${req.method} ${url.pathname} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        result = {
          status: 500,
          body: { error: "internal_error" },
          summary: `internal error: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
        };
      }
    }
    const status = result.status ?? 200;
    try {
      await db.from("bot_activity").insert({
        key_id: bot.keyId,
        bot_name: bot.botName,
        method: req.method,
        endpoint: url.pathname,
        lead_id: result.leadId && isUuid(result.leadId) ? result.leadId : null,
        source_inbox: result.sourceInbox ?? null,
        summary: (result.summary ?? "").slice(0, 2000) || null,
        status_code: status,
      });
    } catch {
      // Activity logging is best effort.
    }
    return NextResponse.json(result.body, { status });
  };
}

/** Read a JSON body or throw 400. */
export async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BotError(400, { error: "invalid_json" }, "invalid JSON body");
  }
}

// ---- Validation --------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;
export function isEmailShape(v: unknown): v is string {
  return typeof v === "string" && EMAIL_RE.test(v.trim());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function isIsoDateTime(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) &&
    !Number.isNaN(new Date(v).getTime())
  );
}

/**
 * Collects field errors with their JSON path; `fail()` throws a 400 with all
 * of them at once so the bot can fix a payload in one round trip.
 */
export class Checker {
  errors: Array<{ path: string; message: string }> = [];

  err(path: string, message: string): void {
    if (this.errors.length < 100) this.errors.push({ path, message });
  }

  obj(v: unknown, path: string, required = true): Record<string, unknown> | undefined {
    if (v === undefined || v === null) {
      if (required) this.err(path, "required object");
      return undefined;
    }
    if (typeof v !== "object" || Array.isArray(v)) {
      this.err(path, "must be an object");
      return undefined;
    }
    return v as Record<string, unknown>;
  }

  /** undefined = absent; null passes through only when nullable. */
  str(
    v: unknown,
    path: string,
    opts: { required?: boolean; nullable?: boolean; max?: number } = {},
  ): string | null | undefined {
    if (v === undefined || (v === null && !opts.nullable)) {
      if (opts.required) this.err(path, "required string");
      return undefined;
    }
    if (v === null) return null;
    if (typeof v !== "string") {
      this.err(path, "must be a string");
      return undefined;
    }
    const t = v.trim();
    if (opts.required && !t) {
      this.err(path, "must not be empty");
      return undefined;
    }
    if (opts.max && t.length > opts.max) {
      this.err(path, `must be at most ${opts.max} characters`);
      return undefined;
    }
    return t;
  }

  oneOf<T extends string>(
    v: unknown,
    path: string,
    values: readonly T[],
    opts: { required?: boolean; nullable?: boolean } = {},
  ): T | null | undefined {
    if (v === undefined || (v === null && !opts.nullable)) {
      if (opts.required) this.err(path, `required, one of: ${values.join(", ")}`);
      return undefined;
    }
    if (v === null) return null;
    if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
      this.err(path, `must be one of: ${values.join(", ")}`);
      return undefined;
    }
    return v as T;
  }

  bool(v: unknown, path: string): boolean | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "boolean") {
      this.err(path, "must be true or false");
      return undefined;
    }
    return v;
  }

  num(v: unknown, path: string, opts: { int?: boolean; nullable?: boolean; min?: number; max?: number } = {}): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null) {
      if (opts.nullable) return null;
      return undefined;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.err(path, "must be a number");
      return undefined;
    }
    if (opts.int && !Number.isInteger(v)) {
      this.err(path, "must be an integer");
      return undefined;
    }
    if (opts.min !== undefined && v < opts.min) {
      this.err(path, `must be >= ${opts.min}`);
      return undefined;
    }
    if (opts.max !== undefined && v > opts.max) {
      this.err(path, `must be <= ${opts.max}`);
      return undefined;
    }
    return v;
  }

  date(v: unknown, path: string, opts: { required?: boolean; nullable?: boolean } = {}): string | null | undefined {
    if (v === undefined || (v === null && !opts.nullable)) {
      if (opts.required) this.err(path, "required date (YYYY-MM-DD)");
      return undefined;
    }
    if (v === null) return null;
    if (!isIsoDate(v)) {
      this.err(path, "must be a date like 2026-03-15");
      return undefined;
    }
    return v;
  }

  email(v: unknown, path: string, opts: { required?: boolean } = {}): string | undefined {
    if (v === undefined || v === null || v === "") {
      if (opts.required) this.err(path, "required email address");
      return undefined;
    }
    if (!isEmailShape(v)) {
      this.err(path, "must be an email address");
      return undefined;
    }
    return (v as string).trim().toLowerCase();
  }

  emails(v: unknown, path: string, opts: { required?: boolean } = {}): string[] | undefined {
    if (v === undefined || v === null) {
      if (opts.required) this.err(path, "required array of email addresses");
      return opts.required ? undefined : [];
    }
    if (!Array.isArray(v)) {
      this.err(path, "must be an array of email addresses");
      return undefined;
    }
    const out: string[] = [];
    v.forEach((e, i) => {
      const ok = this.email(e, `${path}[${i}]`, { required: true });
      if (ok) out.push(ok);
    });
    return out;
  }

  fail(): void {
    if (this.errors.length > 0) {
      throw new BotError(
        400,
        { error: "validation_failed", fields: this.errors },
        `validation failed: ${this.errors
          .slice(0, 3)
          .map((e) => `${e.path} ${e.message}`)
          .join("; ")}`,
      );
    }
  }
}
