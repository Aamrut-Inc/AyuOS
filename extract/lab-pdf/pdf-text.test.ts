import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRows, extractPdfText } from "./pdf-text";
import { indiaStyleReport, usStyleReport } from "./testdata/make-pdf";
import { detectCollectedDate, parseLabRows } from "../../transform/lab-results";

// End-to-end through the real PDFKit/Vision extractor (macOS only).
const macOnly = process.platform === "darwin" ? test : test.skip;
const dir = mkdtempSync(join(tmpdir(), "ayuos-lab-pdf-"));
process.env.AYUOS_DATA_DIR ??= join(dir, "data");

macOnly(
  "extracts every result from a US-style report",
  async () => {
    const path = join(dir, "us.pdf");
    await Bun.write(path, usStyleReport());
    const rows = buildRows(await extractPdfText(path));
    const results = parseLabRows(rows);

    expect(detectCollectedDate(rows)).toBe("2026-03-14");
    expect(results.map((r) => r.analyteKey)).toEqual([
      "glucose", "bun", "creatinine", "egfr", "sodium", "potassium", "alt",
      "cholesterol_total", "triglycerides", "hdl", "ldl_calc", "hba1c", "tsh", "vitamin_d_25oh"
    ]);
    const glucose = results.find((r) => r.analyteKey === "glucose")!;
    expect([glucose.valueNum, glucose.unit, glucose.flag]).toEqual([104, "mg/dL", "H"]);
  },
  120000
);

macOnly(
  "OCRs a scanned (image-only) report",
  async () => {
    const textPdf = join(dir, "in.pdf");
    const png = join(dir, "in.png");
    const scanned = join(dir, "in-scanned.pdf");
    await Bun.write(textPdf, indiaStyleReport());
    await Bun.spawn(["sips", "-s", "format", "png", "-Z", "2200", textPdf, "--out", png], { stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(["sips", "-s", "format", "pdf", png, "--out", scanned], { stdout: "ignore", stderr: "ignore" }).exited;

    const pages = await extractPdfText(scanned);
    expect(pages[0].method).toBe("ocr");
    const results = parseLabRows(buildRows(pages));
    const b12 = results.find((r) => r.analyteKey === "vitamin_b12")!;
    expect([b12.valueNum, b12.unit, b12.flag]).toEqual([180, "pg/mL", "L"]);
    expect(results.find((r) => r.analyteKey === "wbc")!.unit).toBe("10^3/uL");
    expect(results.length).toBeGreaterThanOrEqual(8);
  },
  120000
);
