import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildRows, extractPdfText } from "../extract/lab-pdf/pdf-text";
import { detectCollectedDate, parseLabRows } from "../transform/lab-results";
import { LabStore } from "../load/lab-store";
import type { PostgresConfig } from "../load/config";
import { dataDir } from "../shared/data-dir";

export interface LabImportResult {
  documentId: number;
  duplicate: boolean;
  candidates: number;
}

// Stores an uploaded lab report PDF and reads candidate results from it for
// review. Re-uploading the same file returns the existing document.
export async function importLabPdf(
  postgresConfig: PostgresConfig,
  filename: string,
  bytes: Uint8Array
): Promise<LabImportResult> {
  if (!Buffer.from(bytes.subarray(0, 5)).toString("latin1").startsWith("%PDF-")) {
    throw new Error(`${filename} is not a PDF`);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const store = new LabStore(postgresConfig);
  try {
    const existing = await store.findBySha(sha256);
    if (existing) return { documentId: existing.id, duplicate: true, candidates: 0 };

    const dir = join(dataDir(), "lab-pdfs");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${sha256}.pdf`);
    await Bun.write(filePath, bytes);

    const documentId = await store.createDocument({ sha256, filename, filePath, sizeBytes: bytes.length });
    const candidates = await extractInto(store, documentId, filePath);
    return { documentId, duplicate: false, candidates };
  } finally {
    await store.close();
  }
}

// Re-reads an already stored document (e.g. after parser improvements).
// Results already confirmed or rejected at review are kept as they are.
export async function reparseLabPdf(postgresConfig: PostgresConfig, documentId: number): Promise<number> {
  const store = new LabStore(postgresConfig);
  try {
    const doc = await store.getDocument(documentId);
    if (!doc) throw new Error(`No lab document ${documentId}`);
    return await extractInto(store, documentId, doc.file_path);
  } finally {
    await store.close();
  }
}

async function extractInto(store: LabStore, documentId: number, filePath: string): Promise<number> {
  try {
    const pages = await extractPdfText(filePath);
    const methods = new Set(pages.map((p) => p.method));
    const rows = buildRows(pages);
    const candidates = parseLabRows(rows);
    await store.saveExtraction(
      documentId,
      {
        pageCount: pages.length,
        method: methods.size > 1 ? "mixed" : ([...methods][0] ?? "text"),
        collectedDate: detectCollectedDate(rows)
      },
      candidates
    );
    return candidates.length;
  } catch (error) {
    await store.markFailed(documentId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
