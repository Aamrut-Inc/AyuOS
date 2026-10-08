interface Reference {
  reference?: string;
}

interface Coding {
  system?: string;
  code?: string;
  display?: string;
}

interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

export function bareId(reference: string | undefined): string | null {
  if (!reference) return null;
  const slash = reference.lastIndexOf("/");
  return slash === -1 ? reference : reference.slice(slash + 1);
}

export function bareIds(refs: Reference[] | undefined): string[] {
  return (refs || [])
    .map((r) => bareId(r.reference))
    .filter((id): id is string => id !== null);
}

export function rawRefs(refs: Reference[] | undefined): string[] {
  return (refs || [])
    .map((r) => r.reference)
    .filter((ref): ref is string => Boolean(ref));
}

export function codings(concept: CodeableConcept | undefined): Coding[] {
  return concept?.coding || [];
}

export function codingArrays(concepts: CodeableConcept[] | undefined): Coding[] {
  return (concepts || []).flatMap((c) => c.coding || []);
}

export function categoryCodes(concepts: CodeableConcept[] | undefined): string[] {
  return codingArrays(concepts)
    .map((c) => c.code)
    .filter((code): code is string => Boolean(code));
}

// Human-readable text for a CodeableConcept: its own text, else the first
// coding's display, else the first code.
export function conceptText(concept: CodeableConcept | undefined): string | null {
  if (!concept) return null;
  if (concept.text) return concept.text;
  const coding = concept.coding?.find((c) => c.display) ?? concept.coding?.[0];
  return coding?.display ?? coding?.code ?? null;
}

// FHIR dateTime values may be partial ("2019", "2019-05", "2019-05-17").
// Returns a value Postgres accepts as TIMESTAMPTZ (padded to the first
// instant of the period), or null if it isn't a date at all.
export function fhirInstant(value: string | undefined | null): string | null {
  if (!value) return null;
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  return null;
}
