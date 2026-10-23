/**
 * Organization names hidden inside lead names.
 *
 * Lead names describe a program or event, not just the organization:
 * "ACEC 2027 Annual Convention & Legislative Summit (American Council of
 * Engineering Companies)", "Kenan Institute for Ethics — Duke University",
 * "Distinguished Lecture Series at Trinity University". The engagement guard
 * searches the mailbox for these names (a booking made through a speakers
 * bureau never touches the org's own email domain), and outreach greets a
 * nameless inbox by organization.
 */

/** Event and program words that say nothing about which organization it is. */
const EVENT_WORDS = new Set([
  "annual",
  "convention",
  "conference",
  "conferences",
  "summit",
  "legislative",
  "lecture",
  "lectures",
  "lectureship",
  "series",
  "distinguished",
  "speaker",
  "speakers",
  "speaking",
  "forum",
  "program",
  "programs",
  "programming",
  "festival",
  "meeting",
  "meetings",
  "dinner",
  "gala",
  "luncheon",
  "symposium",
  "keynote",
  "event",
  "events",
  "expo",
  "retreat",
  "fall",
  "spring",
  "summer",
  "winter",
  "public",
  "endowed",
  "membership",
  "executive",
  "general",
  "session",
  "sessions",
  "keynotes",
  "convocation",
  "signature",
]);

/**
 * Words common enough in everyday mail that a phrase made only of them
 * ("International Affairs", "Public Policy Center") identifies nobody.
 */
const COMMON_WORDS = new Set([
  "international", "national", "american", "world", "global", "affairs",
  "policy", "politics", "political", "public", "civic", "democracy",
  "discourse", "institute", "center", "centre", "school", "college",
  "university", "library", "society", "council", "association", "club",
  "foundation", "department", "studies", "leadership", "government",
  "relations", "security", "service", "life", "class", "new", "state",
]);

/** Connectors that shouldn't start or end a name. */
const EDGE_WORDS = new Set(["the", "of", "and", "for", "at", "on", "in", "a", "&", "/", "+"]);

/** All-caps tokens that are too common in mail to identify an organization. */
const ACRONYM_STOPLIST = new Set(["NATO", "USA", "CEO", "LLC", "INC"]);

function tidy(s: string): string {
  return s
    .replace(/\b(19|20)\d{2}(\s*[-–]\s*(19|20)?\d{2})?\b/g, " ") // 2027, 2026-27
    .replace(/\b\d+(st|nd|rd|th)\b/gi, " ") // 34th
    .replace(/["“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/i, "");
}

function isEventWord(w: string): boolean {
  return EVENT_WORDS.has(w.toLowerCase()) || EDGE_WORDS.has(w.toLowerCase());
}

/** Drop event words and connectors from both ends: "ACEC Annual Convention" -> "ACEC". */
function stripEdges(s: string): string {
  const words = s.split(" ").filter(Boolean);
  while (words.length && isEventWord(words[0])) words.shift();
  while (words.length && isEventWord(words[words.length - 1])) words.pop();
  return words.join(" ");
}

function hasSubstance(s: string): boolean {
  return s.split(" ").some((w) => w && !isEventWord(w));
}

function isAcronym(s: string): boolean {
  return (
    /^[A-Z][A-Z&.]+$/.test(s) &&
    s.replace(/[^A-Z]/g, "").length >= 4 &&
    !ACRONYM_STOPLIST.has(s)
  );
}

/**
 * Usable as a mailbox search phrase: two+ words with at least one that is
 * neither an event word nor a common one, or a distinctive acronym.
 */
function searchable(s: string): boolean {
  if (!s) return false;
  if (!s.includes(" ")) return isAcronym(s);
  return s
    .split(" ")
    .some((w) => !isEventWord(w) && !COMMON_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")));
}

/**
 * Pieces of a lead name: the dash/colon/comma-separated segments in order,
 * then parenthetical names. A generic prefix before " at " is dropped
 * ("Lecture Series at Trinity University"). Parentheticals that only give a
 * place ("Stamford, CT", "Missouri") are skipped.
 */
function segments(leadName: string): string[] {
  const parens = [...leadName.matchAll(/\(([^)]+)\)/g)]
    .map((m) => m[1])
    .filter((p) => !p.includes(",") && (p.includes(" ") || isAcronym(p.trim())));
  const main = leadName.replace(/\([^)]*\)/g, " ");
  // "San Antonio, TX" is a place, not the organization.
  const parts = main
    .split(/\s+[-–—|]\s+|:\s+|,\s+/)
    .filter((p, i, all) => !/^[A-Z]{2}$/.test(p.trim()) && !/^[A-Z]{2}$/.test(all[i + 1]?.trim() ?? ""));
  const out: string[] = [];
  for (const raw of [...parts, ...parens]) {
    const t = tidy(raw);
    const at = t.match(/^(.*?)\s+at\s+(.+)$/i);
    if (at && !hasSubstance(stripEdges(tidy(at[1])))) out.push(at[2]);
    else out.push(t);
  }
  // A one-word piece is only an organization if it's an acronym ("ACEC").
  return out.filter((p) => p.includes(" ") || isAcronym(p));
}

/**
 * Phrases to search the mailbox for, e.g. for the ACEC convention lead:
 * ["American Council of Engineering Companies", "ACEC Annual Convention &
 * Legislative Summit", "ACEC"].
 */
export function organizationSearchPhrases(leadName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of segments(leadName)) {
    // The trimmed form only adds an acronym ("ACEC Annual Convention" ->
    // "ACEC"); trimmed word phrases get too generic to search on.
    const trimmed = stripEdges(seg);
    for (const p of isAcronym(trimmed) ? [seg, trimmed] : [seg]) {
      const key = p.toLowerCase();
      if (searchable(p) && !seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * The name to greet a generic inbox by: "American Council of Engineering
 * Companies", "Kenan Institute for Ethics", "Lafayette College". Prefers a
 * multi-word name with no event words in it, so the event title of a lead
 * ("ACEC 2027 Annual Convention ...") gives way to the organization. Null
 * only for an empty lead name; a name with nothing better ("Nareit") is used
 * as is.
 */
export function organizationDisplayName(leadName: string): string | null {
  const names = segments(leadName).filter(hasSubstance);
  const plain = (s: string) => !s.split(" ").some((w) => EVENT_WORDS.has(w.toLowerCase()));
  return (
    names.find((s) => plain(s) && s.includes(" ")) ??
    names.find((s) => s.includes(" ")) ??
    names[0] ??
    (tidy(leadName.replace(/\([^)]*\)/g, " ")) || null)
  );
}

/**
 * Greeting for a contact: "Dear Susan Krys," when there's a name, otherwise
 * "Dear American Council of Engineering Companies team," and, only when even
 * the organization is unknown, a plain "Hello,".
 */
export function greetingFor(
  contactName: string | null | undefined,
  leadName: string | null | undefined,
): string {
  const name = contactName?.trim();
  if (name) return `Dear ${name},`;
  const org = leadName ? organizationDisplayName(leadName) : null;
  return org ? `Dear ${org} team,` : "Hello,";
}
