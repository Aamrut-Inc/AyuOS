import { addDays, localMidnightUtc, localParts } from "./timezone";

// Section 5.4: relative time phrases are resolved here, in code, never by a
// model. Each becomes an explicit range of local calendar days (inclusive)
// plus the UTC instants that bound it, and a label the answer must repeat
// ("over the last 30 days, 2 Oct to 1 Nov").

export interface TimeRange {
  id: string; // r1, r2 ... referenced by the router
  phrase: string;
  kind: "day" | "night" | "rolling" | "week" | "month" | "year" | "since" | "explicit";
  from: string; // local date, inclusive
  to: string; // local date, inclusive
  fromUtc: string;
  toUtc: string; // exclusive
  label: string;
  // "last night" is settled against the sleep data by the context builder.
  needsSleepLookup?: boolean;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NUMBER_WORDS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fourteen: 14, thirty: 30, ninety: 90 };

export function formatDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
}

function range(zone: string, id: string, phrase: string, kind: TimeRange["kind"], from: string, to: string, label: string): TimeRange {
  return {
    id, phrase, kind, from, to,
    fromUtc: localMidnightUtc(zone, from).toISOString(),
    toUtc: localMidnightUtc(zone, addDays(to, 1)).toISOString(),
    label: `${label} (${from === to ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`})`
  };
}

function isoWeekStart(date: string): string {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(date, -((weekday + 6) % 7));
}

function monthStart(date: string, monthsBack = 0): string {
  const d = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return d.toISOString().slice(0, 10);
}

function monthEnd(start: string): string {
  return addDays(monthStart(addDays(start, 32)), -1);
}

export function resolveTimePhrases(message: string, zone: string, now: Date): TimeRange[] {
  const text = ` ${message.toLowerCase().replace(/[’']/g, "'")} `;
  const today = localParts(zone, now).date;
  const out: TimeRange[] = [];
  const seen = new Set<string>();
  const add = (phrase: string, kind: TimeRange["kind"], from: string, to: string, label: string, extra: Partial<TimeRange> = {}) => {
    const key = `${from}|${to}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...range(zone, `r${out.length + 1}`, phrase, kind, from, to, label), ...extra });
  };
  const n = (word: string) => NUMBER_WORDS[word] ?? Number(word);

  if (/\b(today|this morning|tonight)\b/.test(text)) add("today", "day", today, today, "today");
  if (/\byesterday\b/.test(text)) add("yesterday", "day", addDays(today, -1), addDays(today, -1), "yesterday");
  if (/\blast night\b/.test(text)) add("last night", "night", today, today, "last night", { needsSleepLookup: true });

  for (const m of text.matchAll(/\b(?:last|past|previous)\s+(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|thirty|ninety)\s+(day|week|month|year)s?\b/g)) {
    const count = n(m[1]!);
    const days = m[2] === "day" ? count : m[2] === "week" ? count * 7 : m[2] === "month" ? count * 30 : count * 365;
    add(m[0].trim(), "rolling", addDays(today, -(days - 1)), today, `the last ${days} days`);
  }
  if (/\b(?:last|past) (?:7 days|week)\b/.test(text) && !/\blast week\b/.test(text)) add("past week", "rolling", addDays(today, -6), today, "the last 7 days");
  if (/\bpast (?:month|30 days)\b/.test(text)) add("past month", "rolling", addDays(today, -29), today, "the last 30 days");
  if (/\bpast year\b/.test(text)) add("past year", "rolling", addDays(today, -364), today, "the last 365 days");
  if (/\bthis week\b/.test(text)) add("this week", "week", isoWeekStart(today), today, "this week (Monday to today)");
  if (/\blast week\b/.test(text) && !/\blast week(s)?\b.*\bago\b/.test(text)) {
    const start = addDays(isoWeekStart(today), -7);
    add("last week", "week", start, addDays(start, 6), "last week (Monday to Sunday)");
  }
  if (/\bthis month\b/.test(text)) add("this month", "month", monthStart(today), today, "this month");
  if (/\blast month\b/.test(text)) {
    const start = monthStart(today, 1);
    add("last month", "month", start, monthEnd(start), "last month");
  }
  if (/\bthis year\b/.test(text)) add("this year", "year", `${today.slice(0, 4)}-01-01`, today, "this year");
  if (/\blast year\b/.test(text)) {
    const y = Number(today.slice(0, 4)) - 1;
    add("last year", "year", `${y}-01-01`, `${y}-12-31`, "last year");
  }
  if (/\b(recently|lately|these days)\b/.test(text)) add("recently", "rolling", addDays(today, -13), today, "the last 14 days");

  // "since June", "in March", "in March 2026"
  for (const m of text.matchAll(/\b(since|in|during)\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/g)) {
    const month = MONTHS.indexOf(m[2]!) + 1;
    let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    if (!m[3] && start > today) year -= 1;
    const from = `${year}-${String(month).padStart(2, "0")}-01`;
    if (m[1] === "since") add(m[0].trim(), "since", from, today, `since ${formatDay(from)}`);
    else add(m[0].trim(), "month", from, monthEnd(from) > today ? today : monthEnd(from), m[2]!.replace(/^./, (c) => c.toUpperCase()) + ` ${year}`);
  }
  // Explicit ISO dates.
  for (const m of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) add(m[1]!, "explicit", m[1]!, m[1]!, "that day");
  return out;
}
