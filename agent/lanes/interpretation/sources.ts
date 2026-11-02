import { XMLParser } from "fast-xml-parser";
import { htmlToText } from "../../jobs/notes";
import type { TurnLog } from "../../runtime/turn-log";
import { domainAllowed } from "../../compose/checks";

// Section 11.2: vetted medical sources. Search goes to MedlinePlus's public
// search service (NIH), and pages are fetched only from allow-listed domains,
// enforced here in code (redirects included). At most 6 pages per turn, 10 s
// each; fetched text is untrusted data and goes into prompts as <data>.
// Provider-side web search can replace the search step later; the allow-list
// check on every URL stays here either way.

const MEDLINEPLUS_SEARCH = "https://wsearch.nlm.nih.gov/ws/query";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_CHARS = 60_000;

export interface SourcePassage {
  title: string;
  url: string;
  accessed: string;
  passages: string[];
  evidence_id: string;
}

async function guardedFetch(url: string, allowed: string[], signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    if (!domainAllowed(current, allowed) || !current.startsWith("https://")) throw new Error(`${current} is not on the source allow-list`);
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]), headers: { "user-agent": "AyuOS-health-assistant/1.0 (personal, local)" } });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location")!, current).toString();
      continue;
    }
    return response;
  }
  throw new Error("too many redirects");
}

export async function searchMedlinePlus(term: string, signal: AbortSignal): Promise<Array<{ title: string; url: string; summary: string }>> {
  const url = `${MEDLINEPLUS_SEARCH}?db=healthTopics&retmax=5&term=${encodeURIComponent(term)}`;
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
  if (!response.ok) throw new Error(`MedlinePlus search failed (${response.status})`);
  const xml = await response.text();
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(xml);
  const list = doc?.nlmSearchResult?.list?.document;
  const docs = Array.isArray(list) ? list : list ? [list] : [];
  return docs.map((d: any) => {
    const contents = Array.isArray(d.content) ? d.content : [d.content];
    const field = (name: string) => htmlToText(String(contents.find((c: any) => c?.name === name)?.["#text"] ?? ""));
    return { title: field("title"), url: String(d.url), summary: field("FullSummary") };
  });
}

// The paragraphs of a page that mention the most of the given terms.
export function relevantPassages(text: string, terms: string[], max = 4): string[] {
  const words = terms.flatMap((t) => t.toLowerCase().split(/\W+/)).filter((w) => w.length > 3);
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 80 && p.length < 1500);
  return paragraphs
    .map((p) => ({ p, score: words.filter((w) => p.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.p);
}

export async function gatherSources(terms: string[], allowed: string[], log: TurnLog, maxPages = 6): Promise<SourcePassage[]> {
  const accessed = new Date().toISOString().slice(0, 10);
  const candidates = new Map<string, { title: string; summary: string }>();
  for (const term of terms.slice(0, 3)) {
    try {
      for (const hit of await searchMedlinePlus(term, log.signal)) if (!candidates.has(hit.url)) candidates.set(hit.url, hit);
      await log.addEvidence("search", "medlineplus", { term }, [...candidates.keys()]);
    } catch (error) {
      await log.failure("search", "medlineplus", { term }, error instanceof Error ? error.message : String(error));
    }
  }
  const picked = [...candidates.entries()].filter(([url]) => domainAllowed(url, allowed)).slice(0, maxPages);
  const pages = await Promise.all(
    picked.map(async ([url, hit]): Promise<SourcePassage | null> => {
      try {
        const response = await guardedFetch(url, allowed, log.signal);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = htmlToText((await response.text()).slice(0, 2_000_000)).slice(0, MAX_PAGE_CHARS);
        const passages = [hit.summary.slice(0, 1200), ...relevantPassages(text, terms)].filter(Boolean).slice(0, 5);
        const evidence_id = await log.addEvidence("fetch", "source", { url }, { title: hit.title, passages });
        return { title: hit.title, url, accessed, passages, evidence_id };
      } catch (error) {
        // The search summary alone (from the NIH service) still counts as the source text.
        if (!hit.summary) {
          await log.failure("fetch", "source", { url }, error instanceof Error ? error.message : String(error));
          return null;
        }
        const evidence_id = await log.addEvidence("fetch", "source", { url, fetch_error: true }, { title: hit.title, passages: [hit.summary.slice(0, 1500)] });
        return { title: hit.title, url, accessed, passages: [hit.summary.slice(0, 1500)], evidence_id };
      }
    })
  );
  return pages.filter((p): p is SourcePassage => p !== null);
}
