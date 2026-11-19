/**
 * SEND SCHEDULE
 *
 * Every email that leaves the mailbox (first emails and automated follow-ups)
 * goes out on a slot chosen here, so the account looks like one person
 * working through their inbox, not a blast:
 *
 *   - Weekdays only, 8:30am to 4:30pm in the RECIPIENT's time zone (from the
 *     lead's location; US Eastern when unknown). US federal holidays skipped.
 *   - A randomized 2 to 6 minute gap between any two sends from the mailbox.
 *   - At most HOURLY_CAP sends in any 60 minutes and DAILY_CAP per day
 *     (counted on the US Eastern calendar day), first emails and follow-ups
 *     together.
 *   - Two people at the same organization never within ORG_SPACING_MIN of each
 *     other, and at most ORG_DAILY_CAP per organization per day, so an org's
 *     seven contacts spread across the day and into a second day.
 *
 * Pure functions only (no database, no imports) so the rules are easy to read
 * and to test in isolation. lib/outreach/slots.ts feeds them the ledger.
 */

export const SEND_RULES = {
  /** Local business window, minutes after midnight in the recipient's zone. */
  windowStartMin: 8 * 60 + 30,
  windowEndMin: 16 * 60 + 30,
  minGapMs: 2 * 60_000,
  maxGapMs: 6 * 60_000,
  hourlyCap: 20,
  dailyCap: 160,
  orgSpacingMs: 45 * 60_000,
  orgDailyCap: 4,
  /** The calendar the daily caps are counted on (the mailbox's own day). */
  capTimeZone: "America/New_York",
  defaultTimeZone: "America/New_York",
} as const;

export type SendRules = typeof SEND_RULES;

const HOUR_MS = 60 * 60_000;

// --- Time zones ----------------------------------------------------------------

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True when the runtime knows the IANA zone name. */
export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(t: number, tz: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(t))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] ?? 0,
  };
}

function offsetMs(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant a wall-clock time in `tz` happens. Day overflow is allowed. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz);
  return second;
}

/** "2026-11-19" for the calendar day `t` falls on in `tz`. */
export function dayKey(t: number, tz: string): string {
  const p = zonedParts(t, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// --- Holidays ------------------------------------------------------------------

/** nth weekday (0=Sun) of a month; n = -1 for the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(year, month - 1, lastDate)).getUTCDay();
  return lastDate - ((lastDow - weekday + 7) % 7);
}

const holidayCache = new Map<number, Set<string>>();

/**
 * US days nobody wants a cold email: federal holidays plus the Friday after
 * Thanksgiving and Christmas Eve. Month-day keys, e.g. "11-26".
 */
function usHolidays(year: number): Set<string> {
  let s = holidayCache.get(year);
  if (s) return s;
  const md = (m: number, d: number) => `${m}-${d}`;
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  s = new Set([
    md(1, 1),
    md(1, nthWeekday(year, 1, 1, 3)), // MLK Day
    md(2, nthWeekday(year, 2, 1, 3)), // Presidents Day
    md(5, nthWeekday(year, 5, 1, -1)), // Memorial Day
    md(6, 19),
    md(7, 3), // commonly observed / bridge
    md(7, 4),
    md(9, nthWeekday(year, 9, 1, 1)), // Labor Day
    md(11, 11),
    md(11, thanksgiving),
    md(11, thanksgiving + 1),
    md(12, 24),
    md(12, 25),
    md(12, 31),
  ]);
  holidayCache.set(year, s);
  return s;
}

function isOffDay(p: ZonedParts): boolean {
  if (p.weekday === 0 || p.weekday === 6) return true;
  return usHolidays(p.year).has(`${p.month}-${p.day}`);
}

// --- Business window -------------------------------------------------------------

/** True when `t` is inside the recipient's weekday business window. */
export function inSendWindow(t: number, tz: string, rules: SendRules = SEND_RULES): boolean {
  const p = zonedParts(t, tz);
  if (isOffDay(p)) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= rules.windowStartMin && mins < rules.windowEndMin;
}

function windowOpen(p: Pick<ZonedParts, "year" | "month" | "day">, tz: string, rules: SendRules): number {
  return zonedToUtc(
    p.year,
    p.month,
    p.day,
    Math.floor(rules.windowStartMin / 60),
    rules.windowStartMin % 60,
    tz,
  );
}

/** Midnight at the start of the local day after the one `t` falls on. */
export function nextLocalDay(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  return zonedToUtc(p.year, p.month, p.day + 1, 0, 0, tz);
}

/** Midnight at the start of the local day `days` after the one `t` is on. */
export function localDayStartAfter(t: number, days: number, tz: string): number {
  const p = zonedParts(t, tz);
  return zonedToUtc(p.year, p.month, p.day + days, 0, 0, tz);
}

/** Earliest instant at or after `t` that is inside the business window. */
export function nextWindowTime(t: number, tz: string, rules: SendRules = SEND_RULES): number {
  let cur = t;
  for (let i = 0; i < 30; i += 1) {
    const p = zonedParts(cur, tz);
    const mins = p.hour * 60 + p.minute;
    if (!isOffDay(p)) {
      if (mins < rules.windowStartMin) return windowOpen(p, tz, rules);
      if (mins < rules.windowEndMin) return cur;
    }
    cur = nextLocalDay(cur, tz);
  }
  return cur;
}

// --- Recipient time zone -----------------------------------------------------------

const US_STATES: Array<[string, string, string]> = [
  // [abbreviation, full name, zone]
  ["AL", "alabama", "America/Chicago"],
  ["AK", "alaska", "America/Anchorage"],
  ["AZ", "arizona", "America/Phoenix"],
  ["AR", "arkansas", "America/Chicago"],
  ["CA", "california", "America/Los_Angeles"],
  ["CO", "colorado", "America/Denver"],
  ["CT", "connecticut", "America/New_York"],
  ["DE", "delaware", "America/New_York"],
  ["DC", "district of columbia", "America/New_York"],
  ["FL", "florida", "America/New_York"],
  ["GA", "georgia", "America/New_York"],
  ["HI", "hawaii", "Pacific/Honolulu"],
  ["ID", "idaho", "America/Boise"],
  ["IL", "illinois", "America/Chicago"],
  ["IN", "indiana", "America/Indiana/Indianapolis"],
  ["IA", "iowa", "America/Chicago"],
  ["KS", "kansas", "America/Chicago"],
  ["KY", "kentucky", "America/New_York"],
  ["LA", "louisiana", "America/Chicago"],
  ["ME", "maine", "America/New_York"],
  ["MD", "maryland", "America/New_York"],
  ["MA", "massachusetts", "America/New_York"],
  ["MI", "michigan", "America/Detroit"],
  ["MN", "minnesota", "America/Chicago"],
  ["MS", "mississippi", "America/Chicago"],
  ["MO", "missouri", "America/Chicago"],
  ["MT", "montana", "America/Denver"],
  ["NE", "nebraska", "America/Chicago"],
  ["NV", "nevada", "America/Los_Angeles"],
  ["NH", "new hampshire", "America/New_York"],
  ["NJ", "new jersey", "America/New_York"],
  ["NM", "new mexico", "America/Denver"],
  ["NY", "new york", "America/New_York"],
  ["NC", "north carolina", "America/New_York"],
  ["ND", "north dakota", "America/Chicago"],
  ["OH", "ohio", "America/New_York"],
  ["OK", "oklahoma", "America/Chicago"],
  ["OR", "oregon", "America/Los_Angeles"],
  ["PA", "pennsylvania", "America/New_York"],
  ["RI", "rhode island", "America/New_York"],
  ["SC", "south carolina", "America/New_York"],
  ["SD", "south dakota", "America/Chicago"],
  ["TN", "tennessee", "America/Chicago"],
  ["TX", "texas", "America/Chicago"],
  ["UT", "utah", "America/Denver"],
  ["VT", "vermont", "America/New_York"],
  ["VA", "virginia", "America/New_York"],
  ["WA", "washington", "America/Los_Angeles"],
  ["WV", "west virginia", "America/New_York"],
  ["WI", "wisconsin", "America/Chicago"],
  ["WY", "wyoming", "America/Denver"],
  ["PR", "puerto rico", "America/Puerto_Rico"],
];

const CA_PROVINCES: Array<[string, string, string]> = [
  ["BC", "british columbia", "America/Vancouver"],
  ["AB", "alberta", "America/Edmonton"],
  ["SK", "saskatchewan", "America/Regina"],
  ["MB", "manitoba", "America/Winnipeg"],
  ["ON", "ontario", "America/Toronto"],
  ["QC", "quebec", "America/Toronto"],
  ["NS", "nova scotia", "America/Halifax"],
  ["NB", "new brunswick", "America/Halifax"],
  ["NL", "newfoundland", "America/St_Johns"],
  ["PE", "prince edward island", "America/Halifax"],
];

const COUNTRIES: Array<[RegExp, string]> = [
  [/\b(united kingdom|uk|england|scotland|wales|great britain|britain)\b/i, "Europe/London"],
  [/\bireland\b/i, "Europe/Dublin"],
  [/\b(germany|france|belgium|netherlands|switzerland|austria|italy|spain|sweden|norway|denmark|poland|czech|luxembourg)\b/i, "Europe/Berlin"],
  [/\bportugal\b/i, "Europe/Lisbon"],
  [/\bisrael\b/i, "Asia/Jerusalem"],
  [/\b(united arab emirates|uae|dubai)\b/i, "Asia/Dubai"],
  [/\bindia\b/i, "Asia/Kolkata"],
  [/\bsingapore\b/i, "Asia/Singapore"],
  [/\b(japan)\b/i, "Asia/Tokyo"],
  [/\b(south korea|korea)\b/i, "Asia/Seoul"],
  [/\b(taiwan)\b/i, "Asia/Taipei"],
  [/\b(hong kong)\b/i, "Asia/Hong_Kong"],
  [/\baustralia\b/i, "Australia/Sydney"],
  [/\bnew zealand\b/i, "Pacific/Auckland"],
  [/\bmexico\b/i, "America/Mexico_City"],
  [/\bbrazil\b/i, "America/Sao_Paulo"],
];

function matchRegion(text: string, table: Array<[string, string, string]>): string | null {
  const lower = ` ${text.toLowerCase().replace(/[^a-z]+/g, " ")} `;
  // Full names first, longest first ("west virginia" before "virginia").
  for (const [, name, zone] of [...table].sort((a, b) => b[1].length - a[1].length)) {
    if (lower.includes(` ${name} `)) return zone;
  }
  // Then a two-letter code as its own capitalized token ("Austin, TX").
  const tokens = text.split(/[^A-Za-z]+/).filter((t) => /^[A-Z]{2}$/.test(t));
  for (const tok of tokens.reverse()) {
    const hit = table.find(([abbr]) => abbr === tok);
    if (hit) return hit[2];
  }
  return null;
}

/**
 * Best guess at the recipient's time zone from the lead's location fields.
 * US state or Canadian province when one is named, a handful of countries,
 * otherwise US Eastern.
 */
export function timeZoneForLocation(
  region: string | null | undefined,
  country: string | null | undefined,
): string {
  const r = (region ?? "").trim();
  const c = (country ?? "").trim();
  const isCanada = /\bcanada\b/i.test(c) || /\bcanada\b/i.test(r);
  const isUs = !c || /\b(united states|usa|u\.s\.a?\.?|us|america)\b/i.test(c);
  if (isCanada) return matchRegion(r, CA_PROVINCES) ?? "America/Toronto";
  if (isUs) return matchRegion(r, US_STATES) ?? SEND_RULES.defaultTimeZone;
  for (const [re, zone] of COUNTRIES) {
    if (re.test(c) || re.test(r)) return zone;
  }
  return SEND_RULES.defaultTimeZone;
}

// --- Slot allocation -------------------------------------------------------------

/** A send that has happened or is planned, as the allocator sees it. */
export interface Reservation {
  at: number;
  /** Organization identity ("lead:<id>", "dom:<domain>"); overlap = same org. */
  orgKeys: string[];
}

export interface SlotRequest {
  /** Not before this instant. */
  earliest: number;
  /** Recipient time zone. */
  tz: string;
  orgKeys: string[];
}

function sameOrg(a: string[], b: string[]): boolean {
  return a.some((k) => b.includes(k));
}

/** A gap between 2 and 6 minutes, weighted toward the short end (mean ~3.3). */
export function drawGapMs(rand: () => number = Math.random, rules: SendRules = SEND_RULES): number {
  const r = rand();
  return Math.round(rules.minGapMs + (rules.maxGapMs - rules.minGapMs) * r * r);
}

/**
 * The earliest slot at or after `req.earliest` that satisfies every rule
 * against `reservations` (sent + already planned sends). Does not modify the
 * list; callers add the result before allocating the next one.
 */
export function allocateSlot(
  req: SlotRequest,
  reservations: Reservation[],
  opts: { rand?: () => number; rules?: SendRules } = {},
): number {
  const rand = opts.rand ?? Math.random;
  const rules = opts.rules ?? SEND_RULES;
  const sorted = [...reservations].sort((a, b) => a.at - b.at);
  const gap = drawGapMs(rand, rules);
  const capDay = (t: number) => dayKey(t, rules.capTimeZone);

  let t = req.earliest;
  for (let guard = 0; guard < 5000; guard += 1) {
    const opened = nextWindowTime(t, req.tz, rules);
    if (opened !== t) {
      // Don't line every first send of the day up on 8:30:00 sharp.
      t = opened + Math.floor(rand() * 12 * 60_000);
      if (!inSendWindow(t, req.tz, rules)) t = opened;
    }

    const day = capDay(t);
    const sameDay = sorted.filter((r) => capDay(r.at) === day);
    if (sameDay.length >= rules.dailyCap) {
      t = nextLocalDay(t, req.tz);
      continue;
    }
    if (sameDay.filter((r) => sameOrg(r.orgKeys, req.orgKeys)).length >= rules.orgDailyCap) {
      t = nextLocalDay(t, req.tz);
      continue;
    }

    const orgClash = sorted.find(
      (r) => sameOrg(r.orgKeys, req.orgKeys) && Math.abs(r.at - t) < rules.orgSpacingMs,
    );
    if (orgClash) {
      t = orgClash.at + rules.orgSpacingMs + Math.floor(rand() * 15 * 60_000);
      continue;
    }

    let prev: Reservation | null = null;
    let next: Reservation | null = null;
    for (const r of sorted) {
      if (r.at <= t) prev = r;
      else {
        next = r;
        break;
      }
    }
    if (prev && t - prev.at < gap) {
      t = prev.at + gap;
      continue;
    }
    if (next && next.at - t < rules.minGapMs) {
      t = next.at + gap;
      continue;
    }

    // Every 60-minute window that contains t must stay within the cap.
    let pushed = false;
    const starts = [t, ...sorted.filter((r) => r.at > t - HOUR_MS && r.at <= t).map((r) => r.at)];
    for (const x of starts) {
      const inWindow = sorted.filter((r) => r.at >= x && r.at < x + HOUR_MS).length;
      if (inWindow + 1 > rules.hourlyCap) {
        t = x + HOUR_MS + 1000;
        pushed = true;
        break;
      }
    }
    if (pushed) continue;

    // Seconds jitter so sends never land on round minutes, unless it would
    // crowd the next planned send.
    const jitter = Math.floor(rand() * 50_000);
    if (next && next.at - (t + jitter) < rules.minGapMs) return t;
    return t + jitter;
  }
  throw new Error("Could not find a send slot within the scheduling horizon.");
}

/**
 * Whether an email may go out right now, judged against what has actually
 * been SENT. "wait" means only pacing is in the way (try again on the next
 * tick); "reschedule" means the slot itself is wrong now (outside hours, a
 * cap for the day, too close to a colleague) and a new slot is needed.
 */
export type SendVerdict =
  | { ok: true }
  | { ok: false; action: "wait" | "reschedule"; reason: string };

export function sendNowVerdict(
  now: number,
  tz: string,
  orgKeys: string[],
  sent: Reservation[],
  rules: SendRules = SEND_RULES,
): SendVerdict {
  if (!inSendWindow(now, tz, rules)) {
    return { ok: false, action: "reschedule", reason: "Outside the recipient's weekday business hours." };
  }
  const day = dayKey(now, rules.capTimeZone);
  const today = sent.filter((r) => dayKey(r.at, rules.capTimeZone) === day);
  if (today.length >= rules.dailyCap) {
    return { ok: false, action: "reschedule", reason: `Daily cap of ${rules.dailyCap} reached.` };
  }
  const orgToday = today.filter((r) => sameOrg(r.orgKeys, orgKeys));
  if (orgToday.length >= rules.orgDailyCap) {
    return { ok: false, action: "reschedule", reason: "This organization already got its share today." };
  }
  if (sent.some((r) => sameOrg(r.orgKeys, orgKeys) && Math.abs(now - r.at) < rules.orgSpacingMs)) {
    return { ok: false, action: "reschedule", reason: "Someone at this organization was emailed under 45 minutes ago." };
  }
  if (sent.some((r) => Math.abs(now - r.at) < rules.minGapMs)) {
    return { ok: false, action: "wait", reason: "Pacing: the last send was under 2 minutes ago." };
  }
  if (sent.filter((r) => r.at > now - HOUR_MS && r.at <= now).length >= rules.hourlyCap) {
    return { ok: false, action: "wait", reason: `Hourly cap of ${rules.hourlyCap} reached.` };
  }
  return { ok: true };
}
