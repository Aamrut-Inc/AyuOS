import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../shared/data-dir";

// Runs the on-device PDF text/OCR extractor (pdf-text.swift: PDFKit for the
// text layer, Vision for scanned pages). Compiled once per source version and
// cached under the data dir; needs macOS with the Xcode Command Line Tools.

export interface Fragment {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfPage {
  page: number;
  method: "text" | "ocr";
  width: number;
  height: number;
  fragments: Fragment[];
}

const SOURCE = join(import.meta.dir, "pdf-text.swift");

async function ensureBinary(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Lab PDF reading uses macOS PDFKit/Vision and is only available on macOS.");
  }
  const source = readFileSync(SOURCE);
  const version = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const binDir = join(dataDir(), "bin");
  const binary = join(binDir, `pdf-text-${version}`);
  if (existsSync(binary)) return binary;

  mkdirSync(binDir, { recursive: true });
  const proc = Bun.spawn(["swiftc", "-O", SOURCE, "-o", binary], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(
      `Could not compile the PDF reader (needs Xcode Command Line Tools: xcode-select --install). ${stderr.slice(0, 500)}`
    );
  }
  return binary;
}

// Compiles the reader ahead of the first upload (takes ~10s once).
export async function warmPdfReader(): Promise<void> {
  if (process.platform === "darwin") await ensureBinary();
}

export async function extractPdfText(pdfPath: string): Promise<PdfPage[]> {
  const binary = await ensureBinary();
  const proc = Bun.spawn([binary, pdfPath], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new Error(`Could not read PDF: ${stderr.trim() || "unknown error"}`);
  }
  return (JSON.parse(stdout) as { pages: PdfPage[] }).pages;
}

export interface TextRow {
  page: number;
  index: number;
  cells: string[];
  text: string;
}

// Groups positioned fragments into visual rows (fragments whose vertical
// centers fall within half a line height of each other), left to right.
// Table cells end up as separate entries in `cells`, which the parser uses
// as column boundaries when the PDF kept them apart.
export function buildRows(pages: PdfPage[]): TextRow[] {
  const rows: TextRow[] = [];
  for (const page of pages) {
    const fragments = page.fragments
      .filter((f) => f.text.trim())
      .map((f) => ({ ...f, cy: f.y + f.h / 2 }))
      .sort((a, b) => a.cy - b.cy);

    const groups: Array<typeof fragments> = [];
    for (const fragment of fragments) {
      const current = groups[groups.length - 1];
      if (current) {
        const rowCenter = current.reduce((sum, f) => sum + f.cy, 0) / current.length;
        const lineHeight = Math.max(...current.map((f) => f.h), fragment.h);
        if (Math.abs(fragment.cy - rowCenter) <= lineHeight * 0.5) {
          current.push(fragment);
          continue;
        }
      }
      groups.push([fragment]);
    }

    groups.forEach((group, index) => {
      const cells = group.sort((a, b) => a.x - b.x).map((f) => f.text.trim());
      rows.push({ page: page.page, index, cells, text: cells.join("  ") });
    });
  }
  return rows;
}
