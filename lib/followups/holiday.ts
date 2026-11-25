import { SEND_RULES, zonedToUtc } from "@/lib/outreach/schedule";

/**
 * HOLIDAY OUT-OF-OFFICE
 *
 * Pure helpers (no database): spot a holiday out-of-office auto-reply, pull
 * the stated return date out of it, and work out when the paused contact may
 * be emailed again. The scanner (lib/gmail/replyScan.ts) applies the result
 * through lib/followups/holidayApply.ts.
 *
 * Rules:
 *   - Holiday-related: mentions Thanksgiving, Christmas, New Year, "the
 *     holidays" / "holiday break" / "closed for the holidays", or states a
 *     return date between Dec 20 and Jan 12.
 *   - Resume date = 3 business days (Mon-Fri) after the stated return date.
 *   - No return date: Thanksgiving-only -> the Monday after Thanksgiving + 3
 *     business days (2026: Thu Dec 3); otherwise Jan 5 of the coming year
 *     (rolled to Monday if Jan 5 falls on a weekend).
 */

export const HOLIDAY_REASON_PREFIX = "Holiday OOO";
export const HOLIDAY_NOTE_PREFIX = "Holiday out-of-office";
export const HOLIDAY_OPENER =
  "I saw you were out for the holidays, so I wanted to bring this back to the top of your inbox.";

/** Business days added to the stated return date before we write again. */
export const RESUME_BUSINESS_DAYS = 3;

export interface HolidayDetection {
  /** The auto-reply is about the holidays. */
  holiday: boolean;
  /** Mentions Thanksgiving and no other holiday. */
  thanksgivingOnly: boolean;
  /** Stated return date (YYYY-MM-DD), when one could be read. */
  returnDate: string | null;
}

// --- Date utilities (calendar dates as YYYY-MM-DD, no time zone) ------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function iso(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

function parts(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

function weekday(date: string): number {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `n` Mon-Fri days after `date` (the date itself doesn't count). */
export function addBusinessDays(date: string, n: number): string {
  let cur = date;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    const wd = weekday(cur);
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return cur;
}

/** "Jan 2, 2027" */
export function prettyDate(date: string): string {
  const { y, m, d } = parts(date);
  return `${MONTH_ABBR[m - 1]} ${d}, ${y}`;
}

/** Dec 20 through Jan 12, any year. */
export function inHolidayWindow(date: string): boolean {
  const { m, d } = parts(date);
  return (m === 12 && d >= 20) || (m === 1 && d <= 12);
}

function thanksgiving(year: number): string {
  const first = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const day = 1 + ((4 - first + 7) % 7) + 21;
  return iso(year, 11, day) as string;
}

/** A month/day with no year: the next occurrence, allowing a week of slack backwards. */
function inferYear(m: number, d: number, today: string): string | null {
  const { y } = parts(today);
  const floor = addDays(today, -7);
  for (const year of [y, y + 1]) {
    const v = iso(year, m, d);
    if (v && v >= floor) return v;
  }
  return null;
}

// --- Detection ----------------------------------------------------------------

const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const WEEKDAY_RE = "(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s+)?";
const ORD = "(?:st|nd|rd|th)?";

// Each returns [matchIndex, YYYY-MM-DD] for every date found in the text.
function findDates(text: string, today: string): Array<{ index: number; end: number; date: string }> {
  const out: Array<{ index: number; end: number; date: string }> = [];
  const push = (index: number, end: number, date: string | null) => {
    if (date) out.push({ index, end, date });
  };
  // "Monday, January 5th, 2027" / "Jan 5" / "January 5 2027"
  const md = new RegExp(`${WEEKDAY_RE}\\b${MONTH_RE}\\s+(\\d{1,2})${ORD}\\b(?:,?\\s+(\\d{4}))?`, "gi");
  for (const m of text.matchAll(md)) {
    const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
    const day = Number(m[2]);
    const date = m[3] ? iso(Number(m[3]), month, day) : inferYear(month, day, today);
    push(m.index ?? 0, (m.index ?? 0) + m[0].length, date);
  }
  // "5 January 2027" / "Monday 5th January"
  const dm = new RegExp(`${WEEKDAY_RE}\\b(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?`, "gi");
  for (const m of text.matchAll(dm)) {
    const month = MONTHS[m[2].toLowerCase().slice(0, 3)];
    const day = Number(m[1]);
    const date = m[3] ? iso(Number(m[3]), month, day) : inferYear(month, day, today);
    push(m.index ?? 0, (m.index ?? 0) + m[0].length, date);
  }
  // "2027-01-05"
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    push(m.index ?? 0, (m.index ?? 0) + m[0].length, iso(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  // US numeric "1/5", "1/5/27", "01/05/2027"
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12) continue;
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    push(m.index ?? 0, (m.index ?? 0) + m[0].length, year ? iso(year, month, day) : inferYear(month, day, today));
  }
  return out.sort((a, b) => a.index - b.index);
}

// "back on", "return(ing) on", "in the office on", "until", "through" ...
const RETURN_CUE =
  /\b(back(?:\s+in\s+the\s+office)?|return(?:ing|s)?(?:\s+to\s+the\s+office)?|reopen(?:s|ing)?|re-open(?:s|ing)?|resum(?:e|es|ing)|in\s+the\s+office|available|until|till|through|thru|to)\b[^.\n]{0,40}$/i;

/** The stated return date: the first date right after a return cue, else the latest date mentioned. */
export function extractReturnDate(text: string, today: string): string | null {
  const dates = findDates(text, today).filter((d) => d.date >= addDays(today, -7) && d.date <= addDays(today, 150));
  if (dates.length === 0) return null;
  for (const d of dates) {
    const before = text.slice(Math.max(0, d.index - 60), d.index);
    const cue = RETURN_CUE.exec(before);
    if (cue) {
      // "out through Jan 2" means back the day after.
      return /^(through|thru)$/i.test(cue[1]) ? addDays(d.date, 1) : d.date;
    }
  }
  return dates.map((d) => d.date).sort().at(-1) ?? null;
}

const HOLIDAY_WORDS =
  /\b(thanksgiving|christmas|xmas|new\s+year'?s?|hanukkah|chanukah|kwanzaa|festive\s+season|season'?s\s+greetings|winter\s+(break|recess|closure|holidays?|shutdown)|(the|winter|christmas|thanksgiving|year[- ]end|end[- ]of[- ]year)\s+holidays?|holiday\s+(break|closure|season|recess|period|shutdown|schedule|hours)|closed\s+for\s+(the\s+)?holidays?|holidays)\b/i;
const THANKSGIVING = /\bthanksgiving\b/i;
const OTHER_HOLIDAY = /\b(christmas|xmas|new\s+year|hanukkah|chanukah|kwanzaa|winter|festive|year[- ]end|end[- ]of[- ]year)\b/i;

/** Regex prefilter: is this out-of-office about the holidays, and when are they back? */
export function detectHolidayOoo(text: string, today: string): HolidayDetection {
  const returnDate = extractReturnDate(text, today);
  const words = HOLIDAY_WORDS.test(text);
  const holiday = words || Boolean(returnDate && inHolidayWindow(returnDate));
  const thanksgivingOnly = THANKSGIVING.test(text) && !OTHER_HOLIDAY.test(text);
  return { holiday, thanksgivingOnly, returnDate };
}

/** Cheap check: worth asking the model about holiday timing at all? */
export function mightBeHolidayOoo(text: string): boolean {
  return (
    HOLIDAY_WORDS.test(text) ||
    /\b(holiday|dec(ember)?|jan(uary)?|12\/\d|1\/\d)\b/i.test(text)
  );
}

/**
 * Text that is unmistakably an out-of-office / autoresponder. Used so a
 * model failure (or a confused model) can never turn an OOO into
 * "interested". Looks at the opening of the message only.
 */
export function looksLikeOutOfOffice(subject: string, body: string): boolean {
  const head = `${subject}\n${body.slice(0, 500)}`;
  return /\b(automatic\s+reply|auto(-|\s)?reply|autoreply|out\s+of\s+(the\s+)?office|ooo\b|(i\s+am|i'm|i\s+will\s+be|i'll\s+be)\s+(currently\s+)?((away|out)\s+(of|from)\s+(the|my)\s+(office|desk)|(away|out)\s+(until|till|through|for\s+the\s+holidays)|on\s+(vacation|holiday|annual\s+leave|leave|pto))\b|our\s+offices?\s+(is|are|will\s+be)\s+closed|office\s+closure|limited\s+access\s+to\s+(e-?mail|email))/i.test(
    head,
  );
}

/**
 * Stricter than looksLikeOutOfOffice: the message OPENS like an
 * autoresponder ("Automatic reply", "I am currently out of the office until
 * ..."). Safe to override a model's positive classification with, since a
 * human who writes "I was out of the office last week, but yes" won't match.
 */
export function isUnmistakableAutoresponder(subject: string, body: string): boolean {
  if (/^\s*(re:\s*)?(automatic\s+reply|auto(-|\s)?reply|autoreply|out\s+of\s+(the\s+)?office|ooo\b)/i.test(subject)) {
    return true;
  }
  const open = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return /^(hi,?\s+|hello,?\s+)?(this\s+is\s+an\s+(automatic|automated)\s+(reply|response|message)|automatic\s+reply|auto(-|\s)?reply|(thank\s+you|thanks)\s+for\s+your\s+(e-?mail|message|note)[.!,]?\s+(i\s+am|i'm|i\s+will\s+be|our\s+office\s+is)\s+(currently\s+)?(out|away|closed|on\s+(vacation|holiday|leave))|(i\s+am|i'm|i\s+will\s+be)\s+(currently\s+)?(out|away)\s+(of|from)\s+(the|my)\s+office\s+(until|till|through|from|for|and|with|on)|our\s+offices?\s+(is|are|will\s+be)\s+closed\s+(for|until|through|from))/i.test(
    open,
  );
}

/**
 * When the contact may be emailed again (YYYY-MM-DD), given what the
 * auto-reply said.
 */
export function holidayResumeDate(det: HolidayDetection, today: string): string {
  if (det.returnDate) return addBusinessDays(det.returnDate, RESUME_BUSINESS_DAYS);
  const { y, m, d } = parts(today);
  if (det.thanksgivingOnly) {
    const mondayAfter = addDays(thanksgiving(y), 4);
    return addBusinessDays(mondayAfter, RESUME_BUSINESS_DAYS);
  }
  // Jan 5 of the coming year (this year when we're already in early January).
  const year = m === 1 && d <= 12 ? y : y + 1;
  let jan5 = iso(year, 1, 5) as string;
  while (weekday(jan5) === 0 || weekday(jan5) === 6) jan5 = addDays(jan5, 1);
  return jan5;
}

/** Start of the recipient's send window on `date`, as an instant (ms). */
export function resumeEarliestMs(date: string, tz: string): number {
  const { y, m, d } = parts(date);
  return zonedToUtc(
    y,
    m,
    d,
    Math.floor(SEND_RULES.windowStartMin / 60),
    SEND_RULES.windowStartMin % 60,
    tz,
  );
}

/** The contact is still out for the holidays on `today` (recipient-local date). */
export function contactIsOut(
  contact: { ooo_until?: string | null } | null | undefined,
  today: string,
): boolean {
  return Boolean(contact?.ooo_until && contact.ooo_until > today);
}

export function holidayReason(returnDate: string | null, resume: string): string {
  return returnDate
    ? `${HOLIDAY_REASON_PREFIX}: back ${prettyDate(returnDate)}`
    : `${HOLIDAY_REASON_PREFIX}: return date unstated; resuming ${prettyDate(resume)}`;
}

export function holidayNote(p: {
  name: string;
  email: string;
  returnDate: string | null;
  resume: string;
}): string {
  return `${HOLIDAY_NOTE_PREFIX} from ${p.name} (${p.email}): back ${
    p.returnDate ? prettyDate(p.returnDate) : "unstated"
  }. Follow-up delayed to ${prettyDate(p.resume)}.`;
}
