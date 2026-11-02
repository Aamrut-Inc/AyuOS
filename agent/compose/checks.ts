import type { TurnContext } from "../context/types";
import type { PrivacyGuard } from "../gateway/privacy";
import type { Evidence } from "../runtime/turn-log";
import type { Composed, Interpretation } from "../schemas";

// Section 12.2: code checks that must all pass on every answer.

export type LaneKind = "lookup" | "analysis" | "interpretation" | "meta" | "out_of_scope";

export interface CheckFailure {
  check: string;
  detail: string;
}

export interface CheckInput {
  composed: Composed;
  lane: LaneKind;
  evidence: Evidence[];
  ctx: TurnContext;
  question: string;
  guard: PrivacyGuard;
  interpretation?: Interpretation | null;
  allowedDomains: string[];
  identifierRequested?: boolean;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Dates written in the answer, as ISO dates (year defaults to today's).
export function extractDates(text: string, defaultYear: number): { dates: string[]; months: string[]; stripped: string } {
  const dates: string[] = [];
  const months: string[] = [];
  let stripped = text;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    stripped = stripped.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      fn(m);
      return " ";
    });
  };
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => dates.push(iso(+m[1]!, +m[2]!, +m[3]!)));
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?\\b`, "gi"), (m) => dates.push(iso(m[3] ? +m[3] : defaultYear, MONTHS[m[2]!.toLowerCase().slice(0, m[2]!.toLowerCase().startsWith("sept") ? 4 : 3)] ?? MONTHS[m[2]!.toLowerCase().slice(0, 3)]!, +m[1]!)));
  take(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"), (m) => dates.push(iso(m[3] ? +m[3] : defaultYear, MONTHS[m[1]!.toLowerCase().slice(0, 3)]!, +m[2]!)));
  take(new RegExp(`\\b${MONTH_RE}\\s+(\\d{4})\\b`, "gi"), (m) => months.push(`${m[2]}-${String(MONTHS[m[1]!.toLowerCase().slice(0, 3)]).padStart(2, "0")}`));
  take(/\b(\d{1,2}):(\d{2})\b/g, () => {}); // clock times are checked as text below
  return { dates, months, stripped };
}

// Numbers written in the answer, excluding those glued to letters (A1c, B12,
// SpO2, zone 3 names stay; "7 h" and "45%" count).
export function extractNumbers(text: string): Array<{ value: number; decimals: number }> {
  const out: Array<{ value: number; decimals: number }> = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9.\-_/])(-?\d{1,3}(?:,\d{3})+|-?\d+(?:\.\d+)?)(?![A-Za-z0-9]*[A-Za-z][0-9])/g)) {
    const raw = m[1]!.replace(/,/g, "");
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out.push({ value, decimals: raw.includes(".") ? raw.split(".")[1]!.length : 0 });
  }
  return out;
}

function collectValues(value: unknown, numbers: number[], strings: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "number") numbers.push(value);
  else if (typeof value === "string") {
    strings.push(value);
    if (/^-?\d+(\.\d+)?$/.test(value.trim())) numbers.push(Number(value));
    for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) numbers.push(Number(m[0]));
  } else if (Array.isArray(value)) value.forEach((v) => collectValues(v, numbers, strings, depth + 1));
  else if (typeof value === "object") Object.values(value as object).forEach((v) => collectValues(v, numbers, strings, depth + 1));
}

// Every value the answer may legitimately state: evidence values with the
// unit conversions and simple arithmetic a writer does (seconds to hours and
// minutes, fractions to percent, differences and percent changes), row
// counts, and dates and windows from the context.
export function allowedValues(evidence: Evidence[], ctx: TurnContext, question: string) {
  const numbers: number[] = [];
  const strings: string[] = [];
  for (const e of evidence) {
    collectValues(e.output, numbers, strings);
    collectValues(e.input, numbers, strings);
    collectValues(e.searched, numbers, strings);
    if (Array.isArray(e.output)) numbers.push(e.output.length);
  }
  collectValues({ ranges: ctx.time_ranges, today: ctx.today, now: ctx.local_now, freshness: ctx.freshness, profile: ctx.profile, memory: ctx.memory }, numbers, strings);
  collectValues(question, numbers, strings);
  const base = [...new Set(numbers.filter(Number.isFinite))].slice(0, 4000);
  const derived = new Set<number>(base);
  for (const v of base) {
    derived.add(Math.abs(v));
    derived.add(v / 60);
    derived.add(v / 3600);
    derived.add(Math.floor(v / 3600));
    derived.add(Math.round((v % 3600) / 60));
    derived.add(Math.floor(v / 60));
    derived.add(v * 100);
    derived.add(v / 1000);
    derived.add(v / 1000 / 60 / 60);
  }
  const small = base.length <= 400 ? base : base.slice(0, 400);
  for (const a of small) {
    for (const b of small) {
      if (a === b) continue;
      derived.add(Math.abs(a - b));
      derived.add(Math.abs(a - b) / 60);
      derived.add(Math.abs(a - b) / 3600);
      if (a !== 0) derived.add(Math.abs(((b - a) / a) * 100));
    }
  }
  const text = strings.join("\n");
  return { numbers: [...derived], text };
}

function matches(display: { value: number; decimals: number }, allowed: number[]): boolean {
  const tolerance = 0.5 * 10 ** -display.decimals + 1e-9;
  return allowed.some((v) => Math.abs(v - display.value) <= tolerance || Math.abs(Math.abs(v) - Math.abs(display.value)) <= tolerance);
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
}

const HOSPITAL_KEY = /^(obs|cond|rx|allergy|imm|proc|enc|rep|doc|fmh|medstmt|careplan|careteam|goal|servicerequest|specimen|device|questionnaireresponse):/;

export const ALLOWED_DOMAINS_DEFAULT = [
  "medlineplus.gov", "ncbi.nlm.nih.gov", "nih.gov", "cdc.gov", "who.int", "nhs.uk", "nice.org.uk",
  "mayoclinic.org", "clevelandclinic.org", "heart.org", "diabetes.org", "acc.org", "aafp.org", "sleepfoundation.org", "aasm.org"
];

export function domainAllowed(url: string, allowed: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowed.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export function runCodeChecks(input: CheckInput): CheckFailure[] {
  const { composed, evidence, ctx, question, lane } = input;
  const failures: CheckFailure[] = [];
  const answer = composed.answer_markdown;
  const evidenceIds = new Set(evidence.map((e) => e.id));

  // Numbers and dates.
  const allowed = allowedValues(evidence, ctx, question);
  const year = Number(ctx.today.slice(0, 4));
  const { dates, months, stripped } = extractDates(answer, year);
  const contextDates = new Set([ctx.today, ...ctx.time_ranges.flatMap((r) => [r.from, r.to])]);
  for (const d of dates) {
    const inEvidence = allowed.text.includes(d) || contextDates.has(d) || allowed.text.includes(d.replace(/-(\d{2})$/, ""));
    // A date with a defaulted year may belong to last year.
    const lastYear = `${year - 1}${d.slice(4)}`;
    if (!inEvidence && !allowed.text.includes(lastYear) && !contextDates.has(lastYear)) failures.push({ check: "numbers", detail: `date ${d} is not in the evidence` });
  }
  for (const m of months) if (!allowed.text.includes(m) && ![...contextDates].some((d) => d.startsWith(m))) failures.push({ check: "numbers", detail: `month ${m} is not in the evidence` });
  for (const t of answer.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
    const hhmm = `${t[1]!.padStart(2, "0")}:${t[2]}`;
    if (!allowed.text.includes(hhmm) && !ctx.local_now.includes(hhmm)) failures.push({ check: "numbers", detail: `time ${hhmm} is not in the evidence` });
  }
  const tiny = new Set([0, 1, 2]);
  for (const n of extractNumbers(stripped)) {
    if (tiny.has(n.value) && n.decimals === 0) continue;
    if (!matches(n, allowed.numbers)) failures.push({ check: "numbers", detail: `${n.value} does not match any value in the evidence` });
  }

  // Claims carry evidence.
  if (lane !== "out_of_scope") {
    if (evidence.length > 0 && composed.claims.length === 0 && extractNumbers(stripped).length > 0) {
      failures.push({ check: "claims", detail: "the answer states data but lists no claims" });
    }
    for (const c of composed.claims) {
      if (c.evidence_ids.length === 0) failures.push({ check: "claims", detail: `claim without evidence: "${c.text.slice(0, 80)}"` });
      for (const id of c.evidence_ids) if (!evidenceIds.has(id)) failures.push({ check: "claims", detail: `claim cites unknown evidence ${id}` });
    }
  }

  // Providers: no cross-provider comparison of non-comparable metrics.
  for (const s of sentences(answer)) {
    if (/\boura\b/i.test(s) && /\bwhoop\b/i.test(s) && /\b(than|vs\.?|versus|compared|higher|lower|more|less|better|worse|difference|same as)\b/i.test(s)
        && /\b(hrv|heart rate variability|skin temp|temperature|readiness|recovery|efficiency|sleep score|spo2|oxygen)\b/i.test(s)) {
      failures.push({ check: "providers", detail: `compares Oura and Whoop measures that aren't comparable: "${s.slice(0, 100)}"` });
    }
  }

  // Freshness: "as of" for hospital data and stale providers.
  const usesHospital = evidence.some((e) => (Array.isArray(e.provenance) ? (e.provenance as string[]) : []).some((p) => HOSPITAL_KEY.test(String(p))));
  const providersUsed = new Set<string>();
  for (const e of evidence) {
    const inputProvider = (e.input as any)?.provider;
    if (inputProvider) providersUsed.add(inputProvider);
    if (Array.isArray(e.output)) for (const r of e.output.slice(0, 50) as any[]) if (r?.provider) providersUsed.add(r.provider);
  }
  const staleUsed = ctx.freshness.filter((f) => f.stale && providersUsed.has(f.source));
  // "As of" or an equivalent that dates the data ("last data 29 Sep", "imported on 15 Oct").
  const dated = /\bas of\b|\blast (?:data|sync(?:ed)?|reading|updated?)\b|\bimported (?:on )?\d|\bsince (?:the )?(?:last )?(?:import|sync)/i.test(answer);
  if ((usesHospital || staleUsed.length) && lane !== "meta" && !dated) {
    failures.push({ check: "freshness", detail: `missing "as of" date for ${[usesHospital ? "hospital data" : null, ...staleUsed.map((s) => s.display_name)].filter(Boolean).join(", ")}` });
  }

  // Prescriptions are not proof of taking.
  const usesPrescriptions = evidence.some((e) => ["list_prescriptions", "search_medications"].includes(e.name));
  if (usesPrescriptions && /\byou(?:'re|’re| are)?\s+(?:currently\s+|still\s+)?(?:take|taking|takes|on)\s+(?!a\b|an\b|the\s+(?:right|correct))/i.test(answer)) {
    failures.push({ check: "prescriptions", detail: 'says "you take/you\'re taking" for a prescription; say "prescribed"' });
  }

  // Provider scores are named with their provider in the same sentence.
  for (const s of sentences(answer)) {
    if (/\b(sleep|readiness|activity|recovery|resilience)\s+score\b|\bstrain\b|\bsleep performance\b/i.test(s) && !/\b(oura|whoop)('s)?\b/i.test(s)) {
      failures.push({ check: "scores", detail: `provider score without its provider: "${s.slice(0, 100)}"` });
    }
  }

  // Critical lab results come first (8.1, data red flags).
  const critical = evidence.some((e) => Array.isArray(e.output) && (e.output as any[]).some((r) => r?.critical === true));
  if (critical && !/\bcritical\b/i.test(answer)) failures.push({ check: "safety", detail: "a result the lab marked critical is not flagged" });

  // Safety, every lane: no diagnosis as fact, no medication instructions.
  if (/\byou\s+(?:definitely\s+|clearly\s+|certainly\s+)?(?:have|are suffering from|suffer from)\s+(?:a\s+|an\s+)?(?:\w+\s+){0,2}(?:\w*(?:itis|osis|emia|aemia|pathy|oma)|disease|disorder|syndrome|cancer|infection|diabetes|deficiency|hypertension|anemia|anaemia|apnea|apnoea)\b/i.test(answer)) {
    failures.push({ check: "safety", detail: "states a diagnosis as fact" });
  }
  if (/\b(?:you\s+should\s+|please\s+|try\s+to\s+|i\s+(?:recommend|suggest)\s+(?:you\s+)?|consider\s+)?(?:stop|start|increase|decrease|double|halve|reduce|skip|change|adjust|cut)\s+(?:taking\s+|your\s+)?(?:\w+\s+)?(?:dose|dosage|medication|medicine|meds|pills?|tablets?|statin|insulin|\w+(?:pril|olol|sartan|statin|formin|pine|azole|oxetine|aline))\b/i.test(answer)
      && !/\b(?:don'?t|do not|never|without)\s+(?:\w+\s+){0,3}(?:stop|start|change|adjust)/i.test(answer)) {
    failures.push({ check: "safety", detail: "contains a medication instruction" });
  }
  if (/\b(?:you\s+)?(?:don'?t|do not)\s+need\s+to\s+see\s+a\s+(?:doctor|clinician)|\bno need to see a (?:doctor|clinician)/i.test(answer)) {
    failures.push({ check: "safety", detail: 'says "you don\'t need to see a doctor"' });
  }
  if (lane === "interpretation") {
    if (!/\b(doctor|clinician|physician|gp|healthcare provider|care team|nurse)\b/i.test(answer)) failures.push({ check: "safety", detail: "no advice to discuss with a clinician" });
    for (const cause of input.interpretation?.possible_causes ?? []) {
      if (!cause.sources.some((u) => domainAllowed(u, input.allowedDomains))) failures.push({ check: "sources", detail: `possible cause "${cause.name}" has no allow-listed source` });
    }
    for (const w of composed.citations.web) if (!domainAllowed(w.url, input.allowedDomains)) failures.push({ check: "sources", detail: `${w.url} is not on the allow-list` });
  }

  // Privacy.
  if (!input.identifierRequested) {
    const found = input.guard.find(answer);
    if (found.length) failures.push({ check: "privacy", detail: `answer contains identifiers (${found.join(", ")})` });
  }

  // Deduplicate.
  const seen = new Set<string>();
  return failures.filter((f) => {
    const k = `${f.check}|${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
