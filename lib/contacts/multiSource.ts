import { SPEAKER_PROFILE, generateWithWebSearch } from "@/lib/claude/client";
import { extractJson } from "@/lib/claude/json";
import { getEnv } from "@/lib/env";
import { domainFromUrl, looksLikeRealEmail, mapWithConcurrency } from "@/lib/utils";
import type { ContactStatus } from "@/lib/types";
import { hunterDomainPeople, hunterFindPerson } from "@/lib/contacts/hunter";
import { personKey } from "@/lib/contacts/personKey";

export { personKey };

/**
 * Multi-source contact finder. Asks several web-searching LLMs (Claude,
 * OpenAI, Gemini, Perplexity) for up to N people at an org who could book a
 * paid speaker, then:
 *   1. checks each person actually appears on the page the model cited,
 *   2. keeps an email only if it's printed on that page (never a guessed
 *      pattern), and
 *   3. fills remaining gaps with ONE Hunter domain search (1 credit), then
 *   4. runs Hunter's per-person Email Finder (1 credit each) for anyone still
 *      missing an email, so a contact never lands as "needs lookup" when
 *      Hunter could have answered.
 *
 * Every provider is optional: a missing key or a failed call just drops that
 * source. Hunter credits are spent automatically here by design: the
 * operator asked that net-new leads arrive sendable without manual lookups.
 */

export const MAX_CONTACTS_PER_LEAD = 7;
/**
 * Hard ceiling on contact rows per lead, emailed or not. When a full batch
 * comes back with no usable emails the finder gets one more batch of new
 * people; past this ceiling the lead is a dead end and stops being searched.
 */
export const MAX_CONTACT_ROWS_PER_LEAD = MAX_CONTACTS_PER_LEAD * 2;

const PROVIDER_TIMEOUT_MS = 150_000;

export type ContactSource = "claude" | "openai" | "gemini" | "perplexity" | "hunter";

export interface FoundContact {
  name: string;
  role: string | null;
  email: string | null;
  contact_status: ContactStatus;
  source_url: string | null;
  /** Which providers surfaced this person. */
  sources: ContactSource[];
  /** True when Hunter's per-person Email Finder was run for this person. */
  lookupAttempted: boolean;
}

export interface FindContactsResult {
  contacts: FoundContact[];
  /** Providers that returned at least one candidate. */
  succeeded: ContactSource[];
  /** Providers skipped or failed, with a short reason. */
  failed: Array<{ source: ContactSource; reason: string }>;
  hunterUsed: boolean;
}

export interface FindContactsInput {
  name: string;
  type: string;
  description: string | null;
  location: string | null;
  website: string | null;
  source_url: string | null;
  /** Names/emails already on the lead, so we don't re-find them. */
  exclude: Array<{ name: string | null; email: string | null }>;
  max: number;
}

interface Candidate {
  name: string;
  role: string | null;
  email: string | null;
  source_url: string | null;
}

// --- Prompt -----------------------------------------------------------------

function buildPrompt(input: FindContactsInput): string {
  const exclude = input.exclude
    .map((e) => e.name ?? e.email)
    .filter(Boolean)
    .join("; ");
  // Ask for more than we keep: some candidates won't verify.
  const ask = Math.min(input.max + 4, 12);

  return `${SPEAKER_PROFILE}

We want to pitch Jeff Flake as a paid speaker to the organization below. Use web search to find up to ${ask} REAL people there who could invite, approve, or fund an outside speaker.

Organization: ${input.name}
Type: ${input.type}
Description: ${input.description ?? "(none)"}
Location: ${input.location ?? "(unknown)"}
Website: ${input.website ?? "(unknown)"}
${exclude ? `Already have (skip these): ${exclude}\n` : ""}
Who to target:
- At a university or large college, do NOT just return the president, provost, or deans. The best contacts run smaller units with their own speaker budgets: directors, associate directors, and program managers of centers and institutes (politics, public policy, civic engagement, ethics, leadership, democracy, international affairs, faith and public life), people who run endowed or named lecture series and forums, honors programs, political science or public policy department chairs, and student speaker or lecture boards. A center with an endowment for speakers is the single best kind of contact. Include at most one very senior administrator.
- At a small organization (prep school, small college, association, council), the head (head of school, executive director, president) is a good contact, plus whoever runs events, assemblies, or programs.
- Spread across different units rather than many people from one office.

Rules:
- Only people you actually found on a web page. Never invent anyone.
- "source_url" must be the specific page that lists that person (a staff page, directory entry, or bio), not a homepage.
- Include "email" ONLY if it is printed on that page or an official directory. NEVER construct an email from a naming pattern. Use null otherwise.

Return ONLY a JSON array, no prose, no markdown fences:
[{ "name": string, "role": string, "email": string | null, "source_url": string }]`;
}

// --- Providers --------------------------------------------------------------

async function fromClaude(prompt: string): Promise<string> {
  return generateWithWebSearch({
    system:
      "You are a meticulous researcher who finds real staff contacts at organizations using web search. You return only JSON.",
    userPrompt: prompt,
    maxTokens: 8000,
    maxSearches: 8,
    timeoutMs: PROVIDER_TIMEOUT_MS,
    cheap: true,
    feature: "contacts",
  });
}

async function fromOpenAI(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getEnv("OPENAI_MODEL") ?? "gpt-5.5",
      tools: [{ type: "web_search" }],
      reasoning: { effort: "medium" },
      input: prompt,
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const json = (await res.json()) as {
    error?: { message?: string };
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  };
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  }
  return (json.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
}

async function fromGemini(prompt: string, apiKey: string): Promise<string> {
  const model = getEnv("GEMINI_MODEL") ?? "gemini-3.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    },
  );
  const json = (await res.json()) as {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  }
  return (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("\n");
}

async function fromPerplexity(prompt: string, apiKey: string): Promise<string> {
  // Perplexity's Agent API (successor to the Sonar chat endpoint).
  const res = await fetch("https://api.perplexity.ai/v1/agent", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      preset: getEnv("PERPLEXITY_PRESET") ?? "medium",
      input: prompt,
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const json = (await res.json()) as {
    error?: { message?: string };
    output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  };
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  }
  return (json.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
}

/** Strip inline citation markers like "[web:88]" or "[3]" that some providers leave in. */
function stripCitations(s: string): string {
  return s.replace(/\s*\[(?:web:)?\d+\]/gi, "").trim();
}

function parseCandidates(text: string): Candidate[] {
  let raw: unknown;
  try {
    raw = extractJson<unknown>(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Candidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === "string" ? stripCitations(r.name) : "";
    if (!name || personKey(name).split(" ").length < 2) continue;
    const email =
      typeof r.email === "string" && looksLikeRealEmail(r.email)
        ? r.email.trim().toLowerCase()
        : null;
    const url =
      typeof r.source_url === "string" && /^https?:\/\//i.test(r.source_url)
        ? r.source_url.trim()
        : null;
    out.push({
      name,
      role:
        typeof r.role === "string" && stripCitations(r.role) ? stripCitations(r.role) : null,
      email,
      source_url: url,
    });
  }
  return out;
}

// --- Verification -----------------------------------------------------------

interface PageCheck {
  fetched: boolean;
  text: string;
  emails: string[];
}

async function fetchPage(url: string): Promise<PageCheck> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { fetched: false, text: "", emails: [] };
    const html = (await res.text()).slice(0, 2_000_000);
    const decoded = html
      .replace(/&#64;|&commat;/gi, "@")
      .replace(/\s*\[\s*at\s*\]\s*|\s+\(at\)\s+/gi, "@")
      .replace(/\s*\[\s*dot\s*\]\s*|\s+\(dot\)\s+/gi, ".");
    const emails = Array.from(
      new Set(
        (decoded.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((e) =>
          e.toLowerCase(),
        ),
      ),
    );
    const text = decoded
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
    return { fetched: true, text, emails };
  } catch {
    return { fetched: false, text: "", emails: [] };
  }
}

/** Find an email on the page that plausibly belongs to this person. */
function emailForPerson(key: string, emails: string[]): string | null {
  const [first, ...rest] = key.split(" ");
  const last = rest[rest.length - 1];
  if (!first || !last) return null;
  const clean = (s: string) => s.replace(/[^a-z]/g, "");
  const f = clean(first);
  const l = clean(last);
  const matches = emails.filter((e) => {
    const local = clean(e.split("@")[0]);
    return (
      local.includes(l) &&
      (local.includes(f) || local.startsWith(f[0]) || local.endsWith(f[0]))
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

// --- Merge & rank -----------------------------------------------------------

interface Merged {
  key: string;
  name: string;
  role: string | null;
  emails: string[];
  urls: string[];
  sources: Set<ContactSource>;
}

function roleRank(role: string | null): number {
  if (!role) return 0;
  const r = role.toLowerCase();
  if (/(lecture|forum|speaker|series|endow)/.test(r)) return 4;
  if (/(center|centre|institute|program|initiative|events?)/.test(r)) return 3;
  if (/(chair|coordinator|manager|associate director|director)/.test(r)) return 2;
  if (/(president|provost|chancellor|dean)/.test(r)) return 1;
  return 1;
}

// --- Orchestrator -----------------------------------------------------------

export function availableContactSources(): ContactSource[] {
  const s: ContactSource[] = [];
  if (getEnv("ANTHROPIC_API_KEY")) s.push("claude");
  if (getEnv("OPENAI_API_KEY")) s.push("openai");
  if (getEnv("GEMINI_API_KEY")) s.push("gemini");
  if (getEnv("PERPLEXITY_API_KEY")) s.push("perplexity");
  return s;
}

export async function findContactsMultiSource(
  input: FindContactsInput,
): Promise<FindContactsResult> {
  const prompt = buildPrompt(input);
  const failed: FindContactsResult["failed"] = [];
  const succeeded: ContactSource[] = [];

  const runners: Array<[ContactSource, () => Promise<string>]> = [];
  const openaiKey = getEnv("OPENAI_API_KEY");
  const geminiKey = getEnv("GEMINI_API_KEY");
  const pplxKey = getEnv("PERPLEXITY_API_KEY");
  if (getEnv("ANTHROPIC_API_KEY")) runners.push(["claude", () => fromClaude(prompt)]);
  if (openaiKey) runners.push(["openai", () => fromOpenAI(prompt, openaiKey)]);
  if (geminiKey) runners.push(["gemini", () => fromGemini(prompt, geminiKey)]);
  if (pplxKey) runners.push(["perplexity", () => fromPerplexity(prompt, pplxKey)]);

  const settled = await Promise.allSettled(runners.map(([, run]) => run()));

  const excludeKeys = new Set(
    input.exclude.map((e) => (e.name ? personKey(e.name) : "")).filter(Boolean),
  );
  const excludeEmails = new Set(
    input.exclude.map((e) => e.email?.toLowerCase()).filter(Boolean) as string[],
  );

  const merged = new Map<string, Merged>();
  settled.forEach((result, i) => {
    const source = runners[i][0];
    if (result.status === "rejected") {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failed.push({ source, reason: msg.slice(0, 160) });
      return;
    }
    const candidates = parseCandidates(result.value);
    if (candidates.length === 0) {
      failed.push({ source, reason: "returned no usable contacts" });
      return;
    }
    succeeded.push(source);
    for (const c of candidates) {
      const key = personKey(c.name);
      if (!key || excludeKeys.has(key)) continue;
      if (c.email && excludeEmails.has(c.email)) continue;
      const m =
        merged.get(key) ??
        { key, name: c.name, role: null, emails: [], urls: [], sources: new Set() };
      m.sources.add(source);
      if (!m.role && c.role) m.role = c.role;
      if (c.email && !m.emails.includes(c.email)) m.emails.push(c.email);
      if (c.source_url && !m.urls.includes(c.source_url)) m.urls.push(c.source_url);
      merged.set(key, m);
    }
  });

  // Verify against the cited pages (fetch each distinct URL once).
  const allUrls = Array.from(new Set(Array.from(merged.values()).flatMap((m) => m.urls)));
  const pages = new Map<string, PageCheck>();
  await mapWithConcurrency(allUrls, 6, async (url) => {
    pages.set(url, await fetchPage(url));
  });

  const orgDomain = domainFromUrl(input.website) ?? domainFromUrl(input.source_url);
  const found: FoundContact[] = [];

  for (const m of merged.values()) {
    const last = m.key.split(" ").pop() as string;
    let anyFetched = false;
    let seenOn: string | null = null;
    let email: string | null = null;
    let status: ContactStatus = "needs_lookup";

    for (const url of m.urls) {
      const page = pages.get(url);
      if (!page?.fetched) continue;
      anyFetched = true;
      if (!page.text.includes(last)) continue;
      seenOn ??= url;
      // Model-supplied email that's literally on the page, else one we can
      // attribute to this person from the page's own emails.
      const onPage =
        m.emails.find((e) => page.emails.includes(e) || page.text.includes(e)) ??
        emailForPerson(m.key, page.emails);
      if (onPage && looksLikeRealEmail(onPage)) {
        email = onPage;
        status = "verified";
        seenOn = url;
        break;
      }
    }

    // Pages loaded and none mention this person: likely hallucinated. Drop.
    if (anyFetched && !seenOn) continue;

    // Pages unreachable (bot-blocked / JS-rendered): keep the person, and keep
    // an email only if 2+ sources independently gave the same one on the
    // org's own domain.
    if (!email && !anyFetched && orgDomain) {
      const agreed = m.emails.find(
        (e) =>
          e.endsWith(`@${orgDomain}`) || e.endsWith(`.${orgDomain}`),
      );
      if (agreed && m.sources.size >= 2) {
        email = agreed;
        status = "unverified";
      }
    }

    found.push({
      name: m.name,
      role: m.role,
      email,
      contact_status: status,
      source_url: seenOn ?? m.urls[0] ?? null,
      sources: Array.from(m.sources),
      lookupAttempted: false,
    });
  }

  // One Hunter domain search (1 credit) to fill missing emails, and to top up
  // with Hunter's own people if the LLMs came up short.
  let hunterUsed = false;
  const hunterKey = getEnv("HUNTER_API_KEY");
  const needsEmail = found.some((f) => !f.email);
  if (hunterKey && orgDomain && (needsEmail || found.length < input.max)) {
    hunterUsed = true;
    const people = await hunterDomainPeople(orgDomain, hunterKey);
    for (const p of people) {
      if (!looksLikeRealEmail(p.value)) continue;
      const email = (p.value as string).toLowerCase();
      if (excludeEmails.has(email)) continue;
      const full = [p.first_name, p.last_name].filter(Boolean).join(" ");
      const key = full ? personKey(full) : "";
      const existing = key ? found.find((f) => personKey(f.name) === key) : undefined;
      if (existing) {
        if (!existing.email) {
          existing.email = email;
          existing.contact_status = "verified";
        }
        if (!existing.sources.includes("hunter")) existing.sources.push("hunter");
      } else if (key && !excludeKeys.has(key) && roleRank(p.position ?? null) >= 2) {
        found.push({
          name: full,
          role: p.position ?? null,
          email,
          contact_status: "verified",
          source_url: `https://${orgDomain}`,
          sources: ["hunter"],
          lookupAttempted: true,
        });
      }
    }
  }

  // Per-person Email Finder (1 credit each) for anyone the domain search
  // didn't cover. Limited to the people we'd actually keep, so we never pay
  // for contacts that would be cut by the `max` slice below.
  if (hunterKey && orgDomain) {
    const ranked = [...found].sort(
      (a, b) =>
        Number(Boolean(b.email)) - Number(Boolean(a.email)) ||
        b.sources.length - a.sources.length ||
        roleRank(b.role) - roleRank(a.role),
    );
    const missing = ranked.slice(0, input.max).filter((f) => !f.email);
    if (missing.length > 0) {
      hunterUsed = true;
      await mapWithConcurrency(missing, 3, async (f) => {
        f.lookupAttempted = true;
        const hit = await hunterFindPerson(f.name, orgDomain, hunterKey);
        if (!hit || excludeEmails.has(hit.email)) return;
        f.email = hit.email;
        f.contact_status = hit.contact_status;
        if (!f.role && hit.position) f.role = hit.position;
        if (!f.sources.includes("hunter")) f.sources.push("hunter");
      });
    }
  }

  // Emailable people first, then cross-source agreement, then role fit.
  found.sort(
    (a, b) =>
      Number(Boolean(b.email)) - Number(Boolean(a.email)) ||
      b.sources.length - a.sources.length ||
      roleRank(b.role) - roleRank(a.role),
  );

  return {
    contacts: found.slice(0, input.max),
    succeeded,
    failed,
    hunterUsed,
  };
}
