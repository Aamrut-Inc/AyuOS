// BM25 ranking computed locally (13.1, 13.2): memory facts and verified
// examples are few, so a plain in-memory index is enough.

const STOP = new Set("a an and are as at be by did do does for from had has have how i in is it its me my of on or our so than that the their them then there these this to was we were what when where which who why will with you your".split(" "));

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.replace(/(ing|ed|es|s)$/, (m) => (t.length > 5 ? "" : m)));
}

export function bm25<T>(query: string, docs: T[], text: (d: T) => string, k1 = 1.2, b = 0.75): Array<{ doc: T; score: number }> {
  const q = tokenize(query);
  const tokenized = docs.map((d) => tokenize(text(d)));
  const avgLen = tokenized.reduce((s, t) => s + t.length, 0) / (tokenized.length || 1);
  const df = new Map<string, number>();
  for (const tokens of tokenized) for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
  const n = docs.length;
  return docs
    .map((doc, i) => {
      const tokens = tokenized[i]!;
      let score = 0;
      for (const term of q) {
        const f = tokens.filter((t) => t === term).length;
        if (!f) continue;
        const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokens.length) / (avgLen || 1))));
      }
      return { doc, score };
    })
    .sort((a, b2) => b2.score - a.score);
}
