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
