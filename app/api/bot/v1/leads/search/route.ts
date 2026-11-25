import { BotError, botRoute, isEmailShape } from "@/lib/bot/http";
import {
  leadIdsByContactEmail,
  leadIdsByDomain,
  leadIdsByMessageEmail,
  leadIdsByNameContains,
  orgDomain,
  summarizeLeads,
} from "@/lib/bot/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/bot/v1/leads/search?domain=&email=&name=&q=&limit=
 * email: exact (case-insensitive) on contacts and on lead_messages from/to.
 * domain: registrable domain of contact emails or the lead website (generic
 * providers like gmail.com never match). name: contains / normalized match.
 * q: treated as an email, a domain, or a name depending on its shape.
 * Parameters combine as OR; results are ordered by last activity.
 */
export const GET = botRoute(async ({ db, url }) => {
  const sp = url.searchParams;
  let email = sp.get("email")?.trim() || null;
  let domain = sp.get("domain")?.trim() || null;
  let name = sp.get("name")?.trim() || null;
  const q = sp.get("q")?.trim() || null;
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 20, 1), 50);
  if (q) {
    if (isEmailShape(q)) email ??= q;
    else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(q) || /^https?:\/\//i.test(q)) domain ??= q;
    else name ??= q;
  }
  if (!email && !domain && !name) {
    throw new BotError(400, { error: "validation_failed", fields: [{ path: "query", message: "give at least one of email, domain, name, q" }] }, "search: no criteria");
  }
  if (email && !isEmailShape(email)) {
    throw new BotError(400, { error: "validation_failed", fields: [{ path: "email", message: "must be an email address" }] }, "search: bad email");
  }
  const warnings: string[] = [];
  const ids = new Set<string>();
  if (email) {
    for (const id of await leadIdsByContactEmail(db, email)) ids.add(id);
    for (const id of await leadIdsByMessageEmail(db, email)) ids.add(id);
  }
  if (domain) {
    if (!orgDomain(domain)) warnings.push(`${domain} is a personal email provider (or not a domain); domain matching skipped`);
    else for (const id of await leadIdsByDomain(db, domain)) ids.add(id);
  }
  if (name) for (const id of await leadIdsByNameContains(db, name, limit * 2)) ids.add(id);
  const results = (await summarizeLeads(db, Array.from(ids))).slice(0, limit);
  return {
    body: { ok: true, count: results.length, results, warnings },
    summary: `search ${[email && `email=${email}`, domain && `domain=${domain}`, name && `name=${name}`].filter(Boolean).join(" ")}: ${results.length} result(s)`,
  };
});
