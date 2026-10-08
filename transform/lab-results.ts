import type { TextRow } from "../extract/lab-pdf/pdf-text";
import { findAnalyte } from "./lab-analytes";

// Turns text rows from a lab report PDF into candidate results. Lab reports
// have no common format, so this is heuristic: each row is read as
//   <test name> <value>[flag] [flag] [units] [reference range]
// in whatever order the units/range/flag columns come, and scored by how
// much of that shape it matched. Every candidate goes to human review before
// it counts — a misread value is a medical-safety problem, not a cosmetic one.

export interface LabResultCandidate {
  page: number;
  rowIndex: number;
  sourceText: string;
  analyteName: string;
  analyteKey: string | null;
  loinc: string | null;
  valueNum: number | null;
  valueText: string | null;
  comparator: string | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
  flag: string | null;
  confidence: number;
}

// Rows scoring below this aren't shown; at or above DEFAULT_ACCEPT they're
// pre-ticked on the review screen.
export const MIN_CONFIDENCE = 0.5;
export const DEFAULT_ACCEPT = 0.75;

const VALUE = /^(<=|>=|<|>|≤|≥)?(\d{1,6}(?:[.,]\d+)?)(H|L|HH|LL|\*)?$/i;
const COMPARATOR = /^(<=|>=|<|>|≤|≥)$/;
const FLAG = /^(H|L|HH|LL|High|Low|A|Abnormal|Abn|Critical|\*+)$/i;
const FOOTNOTE = /^0\d$/; // LabCorp prints "01", "02" after test names
const QUALITATIVE = /^(non[- ]?reactive|reactive|negative|positive|not detected|detected|nil|absent|present|trace|normal)\b/i;
const RANGE = /(-?\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/i;
const BOUND = /(<=|>=|<|>|≤|≥)\s*(\d+(?:\.\d+)?)/;
const UNIT =
  /^(%|‰|[a-zµμ]{1,6}\/[a-zµμ0-9.\/^]{1,14}|[µμu]?[a-z]{0,3}(IU|U|g|mol|eq|L|l)(\/[a-zµμ0-9.^]+)*|10\^?\d{1,2}\/[a-zµμ]+|x10E\d{1,2}\/[a-zµμ]+|fL|fl|pg|sec|seconds|mm\/hr|cells\/[a-zµμ]+|ratio|index)$/i;
const DATE_LIKE = /^\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}$|^\d{1,2}:\d{2}/;
const LABEL_WORDS =
  /\b(patient|name|dob|birth|age|sex|gender|date|collected|reported|received|registered|phone|tel|mobile|fax|page|account|acct|npi|physician|doctor|dr|ref by|referred|address|specimen|sample|report|laboratory|lab|barcode|accession|time|id|uhid|mrn|client|location|pin|zip)\b/i;

function parseNumber(text: string): number {
  // "1,234" is thousands; "4,5" is a decimal comma.
  const normalized = /,\d{3}$/.test(text) ? text.replace(/,/g, "") : text.replace(",", ".");
  return Number(normalized);
}

function normalizeUnit(unit: string): string {
  // OCR reads 10³/µL or 10^3/µL as "103/uL" or "1013/uL".
  const ocrPower = unit.match(/^10[\^1]?(\d)\/[uµμ]L$/i);
  if (ocrPower) return `10^${ocrPower[1]}/uL`;
  return unit.replace(/[µμ]/g, "u");
}

function cleanName(tokens: string[]): string {
  return tokens
    .join(" ")
    .replace(/[:\-–.,]+$/, "")
    .trim();
}

function validName(name: string): boolean {
  const letters = name.replace(/[^a-z]/gi, "").length;
  if (letters < 2 || name.length > 60 || name.split(/\s+/).length > 8) return false;
  if (name.includes(":")) return false; // "Age/Sex : 45 Y" style field labels
  return !LABEL_WORDS.test(name);
}

interface ParsedTail {
  flag: string | null;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  refText: string | null;
}

function parseTail(tokens: string[]): ParsedTail {
  let flag: string | null = null;
  let unit: string | null = null;
  const rest: string[] = [];

  for (const token of tokens) {
    if (!flag && FLAG.test(token)) {
      flag = token;
    } else if (!unit && UNIT.test(token) && !RANGE.test(token)) {
      unit = normalizeUnit(token);
    } else {
      rest.push(token);
    }
  }

  const restText = rest.join(" ");
  let refLow: number | null = null;
  let refHigh: number | null = null;
  let refText: string | null = null;
  const range = restText.match(RANGE);
  const bound = restText.match(BOUND);
  if (range) {
    refLow = Number(range[1]);
    refHigh = Number(range[2]);
    refText = range[0].replace(/\s+/g, " ");
  } else if (bound) {
    const value = Number(bound[2]);
    if (bound[1].startsWith("<") || bound[1] === "≤") refHigh = value;
    else refLow = value;
    refText = bound[0].replace(/\s+/g, "");
  } else {
    const qualitative = restText.match(QUALITATIVE);
    if (qualitative) refText = qualitative[0];
  }

  return { flag, unit, refLow, refHigh, refText };
}

function normalizeFlag(flag: string | null): string | null {
  if (!flag) return null;
  const f = flag.toUpperCase();
  if (f === "HIGH" || f === "HH") return "H";
  if (f === "LOW" || f === "LL") return "L";
  if (f === "H" || f === "L") return f;
  return "A"; // abnormal / critical / asterisk
}

function inferFlag(value: number | null, refLow: number | null, refHigh: number | null): string | null {
  if (value === null) return null;
  if (refHigh !== null && value > refHigh) return "H";
  if (refLow !== null && value < refLow) return "L";
  return null;
}

export function parseLabRow(row: TextRow): LabResultCandidate | null {
  const tokens = row.text.split(/\s+/).filter(Boolean);
  if (tokens.some((t) => DATE_LIKE.test(t)) && LABEL_WORDS.test(row.text)) return null;

  for (let i = 1; i < tokens.length; i++) {
    let nameTokens = tokens.slice(0, i);
    if (FOOTNOTE.test(nameTokens[nameTokens.length - 1] ?? "") && nameTokens.length > 1) {
      nameTokens = nameTokens.slice(0, -1);
    }
    const name = cleanName(nameTokens);

    // Numeric result, optionally with a separate comparator token before it.
    let comparator: string | null = null;
    let valueIndex = i;
    if (COMPARATOR.test(tokens[i]) && i + 1 < tokens.length) {
      comparator = tokens[i];
      valueIndex = i + 1;
    }
    const valueMatch = tokens[valueIndex].match(VALUE);
    const qualitative = valueMatch ? null : tokens.slice(i).join(" ").match(QUALITATIVE);
    if (!valueMatch && !qualitative) continue;
    if (FOOTNOTE.test(tokens[i]) && !comparator) continue;
    if (!validName(name)) continue;

    const analyte = findAnalyte(name);
    let valueNum: number | null = null;
    let valueText: string | null = null;
    let attachedFlag: string | null = null;
    let tail: ParsedTail;

    if (valueMatch) {
      comparator = comparator ?? valueMatch[1] ?? null;
      valueNum = parseNumber(valueMatch[2]);
      attachedFlag = valueMatch[3] ?? null;
      tail = parseTail(tokens.slice(valueIndex + 1));
    } else {
      valueText = qualitative![0];
      const consumed = valueText.split(/\s+/).length;
      tail = parseTail(tokens.slice(i + consumed));
    }

    // A name that's itself a number-ish code ("25" in "25 OH Vitamin D") is
    // handled by moving on to the next numeric token, so require real letters
    // before accepting; then score what else the row gave us.
    let confidence = 0;
    if (analyte) confidence += 0.4;
    if (tail.unit) confidence += 0.25;
    if (tail.refText) confidence += 0.25;
    if (valueNum !== null) confidence += 0.1;
    if (confidence < MIN_CONFIDENCE) {
      // A known analyte might simply be followed by a numeric code; keep looking.
      continue;
    }

    const flag =
      normalizeFlag(attachedFlag ?? tail.flag) ?? inferFlag(valueNum, tail.refLow, tail.refHigh);

    return {
      page: row.page,
      rowIndex: row.index,
      sourceText: row.text,
      analyteName: analyte?.name ?? name,
      analyteKey: analyte?.key ?? null,
      loinc: analyte?.loinc ?? null,
      valueNum,
      valueText,
      comparator,
      unit: tail.unit,
      refLow: tail.refLow,
      refHigh: tail.refHigh,
      refText: tail.refText,
      flag,
      confidence: Math.round(confidence * 100) / 100
    };
  }
  return null;
}

export function parseLabRows(rows: TextRow[]): LabResultCandidate[] {
  return rows.map(parseLabRow).filter((c): c is LabResultCandidate => c !== null);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

interface FoundDate {
  line: string;
  index: number; // position in the line
  year: number;
  a: number; // first numeric part (month or day), or the day for named months
  b: number;
  named: boolean; // month given by name, so unambiguous
}

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

function findDates(line: string): FoundDate[] {
  const found: FoundDate[] = [];
  for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    found.push({ line, index: m.index!, year: Number(m[1]), a: Number(m[2]), b: Number(m[3]), named: true });
  }
  for (const m of line.matchAll(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/g)) {
    found.push({ line, index: m.index!, year: fullYear(Number(m[3])), a: Number(m[1]), b: Number(m[2]), named: false });
  }
  for (const m of line.matchAll(/\b(\d{1,2})[\s\-]([A-Za-z]{3,9})[\s\-,]+(\d{2,4})\b/g)) {
    const month = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (month) found.push({ line, index: m.index!, year: fullYear(Number(m[3])), a: month, b: Number(m[1]), named: true });
  }
  for (const m of line.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
    const month = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) found.push({ line, index: m.index!, year: Number(m[3]), a: month, b: Number(m[2]), named: true });
  }
  return found;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// The specimen collection date, as an ISO date (YYYY-MM-DD), or null.
// Numeric dates are ambiguous (03/04 = March 4 or 3 April); any date in the
// document with a part > 12 settles the order for all of them, otherwise
// month-first is assumed and the reviewer can correct it.
export function detectCollectedDate(rows: TextRow[]): string | null {
  const dates = rows.flatMap((row) => findDates(row.text));
  if (dates.length === 0) return null;

  const numeric = dates.filter((d) => !d.named);
  const dayFirst = numeric.some((d) => d.a > 12) && !numeric.some((d) => d.b > 12);
  const iso = (d: FoundDate) => (d.named || !dayFirst ? toIso(d.year, d.a, d.b) : toIso(d.year, d.b, d.a));

  // Prefer the first date after a "collected"-type keyword on its line
  // ("Reported: X  Collected: Y" must pick Y); skip dates of birth.
  const COLLECTED = /collect|drawn|specimen|sample/i;
  const collected = dates.find((d) => {
    const keyword = d.line.search(COLLECTED);
    if (keyword < 0 || d.index < keyword) return false;
    return !/\b(dob|birth)\b/i.test(d.line.slice(keyword, d.index));
  });
  const chosen = collected ?? dates.find((d) => !/\b(dob|birth)\b/i.test(d.line.slice(0, d.index + 1)));
  return chosen ? iso(chosen) : null;
}

// Parses a reference interval typed or corrected by a reviewer.
export function parseReference(text: string): { refLow: number | null; refHigh: number | null; refText: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { refLow: null, refHigh: null, refText: null };
  const range = trimmed.match(RANGE);
  if (range) return { refLow: Number(range[1]), refHigh: Number(range[2]), refText: trimmed };
  const bound = trimmed.match(BOUND);
  if (bound) {
    const value = Number(bound[2]);
    const upper = bound[1].startsWith("<") || bound[1] === "≤";
    return { refLow: upper ? null : value, refHigh: upper ? value : null, refText: trimmed };
  }
  return { refLow: null, refHigh: null, refText: trimmed };
}

// Parses a result value typed or corrected by a reviewer: numeric (with an
// optional comparator) or free text such as "Negative".
export function parseValue(text: string): { valueNum: number | null; valueText: string | null; comparator: string | null } {
  const trimmed = text.trim();
  const m = trimmed.match(/^(<=|>=|<|>|≤|≥)?\s*(\d+(?:[.,]\d+)?)$/);
  if (m) return { valueNum: parseNumber(m[2]), valueText: null, comparator: m[1] ?? null };
  return { valueNum: null, valueText: trimmed || null, comparator: null };
}
