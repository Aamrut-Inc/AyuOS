import type { SQL } from "bun";

// Section 6.3: before anything leaves the Mac, the person's identifiers are
// replaced with placeholders. The agent views never expose them, but note
// text, raw JSON and the person's own messages can. Identifiers are loaded
// with the app's main role and kept in memory only; redaction events are
// logged by kind, never with the value.

export type IdentifierKind = "name" | "birth date" | "id" | "phone" | "email" | "address";

export interface Identifier {
  kind: IdentifierKind;
  pattern: RegExp;
}

export interface RedactionEvent {
  kind: IdentifierKind;
  count: number;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Given names that are also everyday words (and month names) would redact
// ordinary text, so they are matched only next to the family name.
const COMMON_WORDS = new Set([...MONTHS.map((m) => m.toLowerCase()), "will", "mark", "may", "june", "april", "august", "hope", "joy", "grace", "faith", "rose", "dawn", "summer", "art", "bill", "pat", "sky", "max", "ray", "sun", "eve", "jan"]);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function birthDatePatterns(iso: string): string[] {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  const month = MONTHS[m - 1]!;
  const mon = month.slice(0, 3);
  return [
    iso,
    `${mm}/${dd}/${y}`, `${m}/${d}/${y}`, `${dd}/${mm}/${y}`, `${d}/${m}/${y}`,
    `${dd}-${mm}-${y}`, `${dd}.${mm}.${y}`,
    `${month} ${d}, ${y}`, `${month} ${d} ${y}`, `${d} ${month} ${y}`, `${mon} ${d}, ${y}`, `${d} ${mon} ${y}`, `${mon} ${d} ${y}`
  ];
}

function digitsPattern(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  // The last 7+ digits with any separators between them.
  const tail = digits.slice(-Math.min(digits.length, 10));
  return tail.split("").join("[\\s.()+-]*");
}

export function buildIdentifiers(raw: {
  givenNames: string[];
  familyNames: string[];
  birthDates: string[];
  ids: string[];
  phones: string[];
  emails: string[];
  addresses: string[];
}): Identifier[] {
  const out: Identifier[] = [];
  const add = (kind: IdentifierKind, source: string, flags = "gi") => out.push({ kind, pattern: new RegExp(source, flags) });
  const families = [...new Set(raw.familyNames.filter((f) => f && f.length >= 2))];
  const givens = [...new Set(raw.givenNames.filter((g) => g && g.length >= 2))];
  for (const email of new Set(raw.emails.filter(Boolean))) add("email", escape(email));
  for (const given of givens) {
    for (const family of families) {
      add("name", `\\b${escape(given)}\\s+${escape(family)}\\b`);
      add("name", `\\b${escape(family)},?\\s+${escape(given)}\\b`);
    }
  }
  for (const family of families) {
    add("name", `\\b${escape(family)}\\b`);
    // Hyphenated family names are also redacted part by part.
    for (const part of family.split(/[-\s]+/)) if (part.length >= 4 && !COMMON_WORDS.has(part.toLowerCase())) add("name", `\\b${escape(part)}\\b`);
  }
  for (const given of givens) if (given.length >= 3 && !COMMON_WORDS.has(given.toLowerCase())) add("name", `\\b${escape(given)}\\b`);
  for (const date of new Set(raw.birthDates.filter(Boolean))) {
    for (const form of birthDatePatterns(date)) add("birth date", `(?<![\\d/.-])${escape(form)}(?![\\d/.-])`);
  }
  for (const id of new Set(raw.ids.filter((v) => v && v.replace(/\W/g, "").length >= 4))) add("id", `(?<![\\w-])${escape(id)}(?![\\w-])`);
  for (const phone of new Set(raw.phones.filter(Boolean))) {
    const p = digitsPattern(phone);
    if (p) add("phone", p);
  }
  for (const address of new Set(raw.addresses.filter((a) => a && a.length >= 6))) add("address", escape(address));
  return out;
}

export async function loadIdentifiers(main: SQL): Promise<Identifier[]> {
  const patients = await main`
    SELECT family_name, given_names, birth_date::text AS birth_date, phone, email, address_line, address_postal_code
    FROM clinical.patient
  `;
  const ids = await main`SELECT value FROM clinical.patient_identifier`;
  const wearable = await main`
    SELECT json ->> 'email' AS email, json ->> 'first_name' AS first_name, json ->> 'last_name' AS last_name
    FROM wearables.records WHERE is_current AND data_type IN ('personal_info', 'profile')
  `;
  return buildIdentifiers({
    givenNames: [...patients.flatMap((p: any) => p.given_names ?? []), ...wearable.map((w: any) => w.first_name)].filter(Boolean),
    familyNames: [...patients.map((p: any) => p.family_name), ...wearable.map((w: any) => w.last_name)].filter(Boolean),
    birthDates: patients.map((p: any) => p.birth_date).filter(Boolean),
    ids: ids.map((i: any) => i.value),
    phones: patients.flatMap((p: any) => p.phone ?? []),
    emails: [...patients.flatMap((p: any) => p.email ?? []), ...wearable.map((w: any) => w.email)].filter(Boolean),
    addresses: patients.flatMap((p: any) => [p.address_line]).filter(Boolean)
  });
}

const PLACEHOLDER: Record<IdentifierKind, string> = {
  name: "[name]",
  "birth date": "[birth date]",
  id: "[id]",
  phone: "[phone]",
  email: "[email]",
  address: "[address]"
};

export class PrivacyGuard {
  constructor(private readonly identifiers: Identifier[]) {}

  static empty(): PrivacyGuard {
    return new PrivacyGuard([]);
  }

  redact(text: string): { text: string; events: RedactionEvent[] } {
    const counts = new Map<IdentifierKind, number>();
    let out = text;
    for (const id of this.identifiers) {
      out = out.replace(id.pattern, () => {
        counts.set(id.kind, (counts.get(id.kind) ?? 0) + 1);
        return PLACEHOLDER[id.kind];
      });
    }
    return { text: out, events: [...counts].map(([kind, count]) => ({ kind, count })) };
  }

  // Whether any identifier occurs (for the verifier's privacy check).
  find(text: string): IdentifierKind[] {
    return [...new Set(this.identifiers.filter((id) => new RegExp(id.pattern.source, "i").test(text)).map((id) => id.kind))];
  }

  // Redacts every string inside a JSON-like value.
  redactDeep<T>(value: T, events: RedactionEvent[] = []): T {
    if (typeof value === "string") {
      const r = this.redact(value);
      events.push(...r.events);
      return r.text as T;
    }
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v, events)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactDeep(v, events)])) as T;
    }
    return value;
  }
}

export function mergeEvents(events: RedactionEvent[]): RedactionEvent[] {
  const m = new Map<IdentifierKind, number>();
  for (const e of events) m.set(e.kind, (m.get(e.kind) ?? 0) + e.count);
  return [...m].map(([kind, count]) => ({ kind, count }));
}
