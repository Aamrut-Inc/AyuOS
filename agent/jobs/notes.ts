import type { SQL } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { extractPdfText } from "../../extract/lab-pdf/pdf-text";

// Section 14.1: text of downloaded clinical-note files, one row per
// attachment in agent.note_text plus ~800-character chunks in
// agent.note_chunks for full-text search. Text stays on the Mac; it is
// redacted only when it goes into a prompt (gateway/privacy.ts).

const CHUNK_CHARS = 800;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|title)>/gi, "\n\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Clinical document XML (C-CDA): each section's title and narrative text.
export function cdaToText(xml: string): string {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, textNodeName: "#text" });
  const doc = parser.parse(xml);
  const out: string[] = [];
  const flatten = (node: unknown): string => {
    if (node === null || node === undefined) return "";
    if (typeof node !== "object") return String(node);
    if (Array.isArray(node)) return node.map(flatten).filter(Boolean).join("\n");
    return Object.values(node as Record<string, unknown>).map(flatten).filter(Boolean).join(" ");
  };
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "section") {
        for (const section of Array.isArray(value) ? value : [value]) {
          const s = section as Record<string, unknown>;
          const title = flatten(s.title).trim();
          const text = flatten(s.text).replace(/\s+/g, " ").trim();
          if (title || text) out.push([title, text].filter(Boolean).join("\n"));
          walk(s.component);
        }
      } else {
        walk(value);
      }
    }
  };
  walk(doc);
  if (out.length > 0) return out.join("\n\n");
  // Not a sectioned document: fall back to all text content.
  return flatten(doc).replace(/\s+/g, " ").trim();
}

function rtfToText(path: string): string {
  const result = Bun.spawnSync(["textutil", "-convert", "txt", "-stdout", path], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`textutil failed: ${result.stderr.toString().slice(0, 200)}`);
  return result.stdout.toString().trim();
}

export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    const pieces = paragraph.length > size ? paragraph.match(new RegExp(`[\\s\\S]{1,${size}}(\\s|$)`, "g")) ?? [paragraph] : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > size) {
        chunks.push(current.trim());
        current = "";
      }
      current += (current ? "\n\n" : "") + piece;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function methodFor(contentType: string | null, path: string): string {
  const type = (contentType ?? "").toLowerCase().split(";")[0]!.trim();
  if (type.includes("html") || /\.x?html?$/i.test(path)) return "html";
  if (type.includes("rtf") || /\.rtf$/i.test(path)) return "rtf";
  if (type.includes("xml") || /\.xml$/i.test(path)) return "xml";
  if (type === "application/pdf" || /\.pdf$/i.test(path)) return "pdf";
  if (type.startsWith("text/") || /\.txt$/i.test(path)) return "text";
  return "unsupported";
}

export async function extractFile(path: string, method: string): Promise<string> {
  switch (method) {
    case "html":
      return htmlToText(readFileSync(path, "utf8"));
    case "rtf":
      return rtfToText(path);
    case "xml":
      return cdaToText(readFileSync(path, "utf8"));
    case "text":
      return readFileSync(path, "utf8").trim();
    case "pdf": {
      // Text-layer pages only; scanned pages are 'unsupported' for now (14.1)
      // even though the reader can OCR them.
      const pages = await extractPdfText(path);
      return pages
        .filter((p) => p.method === "text")
        .map((p) => p.fragments.map((f) => f.text).join(" "))
        .join("\n\n")
        .trim();
    }
    default:
      return "";
  }
}

export interface NoteExtractionSummary {
  attempted: number;
  extracted: number;
  byMethod: Record<string, { ok: number; failed: number }>;
}

// Every downloaded attachment without a note_text row. Scanned PDFs (no
// text layer) and images are stored as 'unsupported' for now.
export async function extractNotes(main: SQL): Promise<NoteExtractionSummary> {
  const pending = await main`
    SELECT a.id, a.content_type, a.file_path
    FROM clinical.fhir_attachments a
    LEFT JOIN agent.note_text t ON t.attachment_id = a.id
    WHERE a.file_path IS NOT NULL AND a.error IS NULL AND t.attachment_id IS NULL
    ORDER BY a.id
  `;
  const summary: NoteExtractionSummary = { attempted: 0, extracted: 0, byMethod: {} };
  for (const row of pending) {
    summary.attempted += 1;
    let method = methodFor(row.content_type, row.file_path);
    let text = "";
    let error: string | null = null;
    try {
      if (!existsSync(row.file_path)) throw new Error("file missing on disk");
      text = method === "unsupported" ? "" : await extractFile(row.file_path, method);
      if (method === "pdf" && !text) method = "unsupported"; // scanned: no text layer
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      method = method === "unsupported" ? method : "failed";
    }
    const stat = (summary.byMethod[methodFor(row.content_type, row.file_path)] ??= { ok: 0, failed: 0 });
    if (text) {
      stat.ok += 1;
      summary.extracted += 1;
    } else stat.failed += 1;

    await main.begin(async (tx) => {
      await tx`
        INSERT INTO agent.note_text (attachment_id, text, method, char_count, error)
        VALUES (${row.id}, ${text || null}, ${method}, ${text.length}, ${error})
      `;
      for (const [i, chunk] of chunkText(text).entries()) {
        await tx`INSERT INTO agent.note_chunks (attachment_id, chunk_no, text) VALUES (${row.id}, ${i}, ${chunk})`;
      }
    });
  }
  return summary;
}

// Re-extract everything (e.g. after improving an extractor).
export async function resetNotes(main: SQL): Promise<void> {
  await main`DELETE FROM agent.note_text`;
}
