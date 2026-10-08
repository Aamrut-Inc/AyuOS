// Builds minimal single-font PDFs with text at fixed positions, so tests can
// exercise real PDF extraction without committing (or reading) real reports.

export interface TextRun {
  x: number;
  y: number; // from the top of the page
  text: string;
  size?: number;
}

const PAGE_W = 612;
const PAGE_H = 792;

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function makePdf(pages: TextRun[][]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pagesId = add(""); // placeholder, filled after pages are known
  const pageIds: number[] = [];

  for (const runs of pages) {
    const content = runs
      .map((r) => `BT /F1 ${r.size ?? 10} Tf ${r.x} ${PAGE_H - r.y} Td (${escapePdfText(r.text)}) Tj ET`)
      .join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
      )
    );
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

// Lays out table rows: each row is a list of [x, text] cells at one y.
export function table(startY: number, rows: Array<Array<[number, string]>>, lineHeight = 16): TextRun[] {
  return rows.flatMap((cells, i) => cells.map(([x, text]) => ({ x, y: startY + i * lineHeight, text })));
}

// US reference-lab style: name | result + flag | units | reference interval.
export function usStyleReport(): Uint8Array {
  return makePdf([
    [
      { x: 40, y: 40, text: "Sample Reference Laboratory", size: 14 },
      { x: 40, y: 62, text: "Patient: TEST, PATIENT     DOB: 01/01/1980" },
      { x: 40, y: 78, text: "Date Collected: 03/14/2026 08:12     Date Reported: 03/15/2026" },
      { x: 40, y: 94, text: "Ordering Physician: Example, MD     Phone: 555-123-4567" },
      ...table(130, [
        [[40, "TEST"], [250, "RESULT"], [330, "FLAG"], [380, "UNITS"], [470, "REFERENCE INTERVAL"]],
        [[40, "Comprehensive Metabolic Panel"]],
        [[40, "Glucose"], [250, "104"], [330, "H"], [380, "mg/dL"], [470, "65-99"]],
        [[40, "BUN"], [250, "14"], [380, "mg/dL"], [470, "6-24"]],
        [[40, "Creatinine"], [250, "0.94"], [380, "mg/dL"], [470, "0.76-1.27"]],
        [[40, "eGFR"], [250, "102"], [380, "mL/min/1.73"], [470, ">59"]],
        [[40, "Sodium"], [250, "139"], [380, "mmol/L"], [470, "134-144"]],
        [[40, "Potassium"], [250, "4.3"], [380, "mmol/L"], [470, "3.5-5.2"]],
        [[40, "ALT (SGPT)"], [250, "48"], [330, "H"], [380, "IU/L"], [470, "0-44"]],
        [[40, "Lipid Panel"]],
        [[40, "Cholesterol, Total"], [250, "212"], [330, "High"], [380, "mg/dL"], [470, "100-199"]],
        [[40, "Triglycerides"], [250, "150"], [380, "mg/dL"], [470, "0-149"]],
        [[40, "HDL Cholesterol"], [250, "45"], [380, "mg/dL"], [470, ">39"]],
        [[40, "LDL Chol Calc (NIH)"], [250, "137"], [330, "H"], [380, "mg/dL"], [470, "0-99"]],
        [[40, "Hemoglobin A1c"], [250, "5.9"], [330, "H"], [380, "%"], [470, "4.8-5.6"]],
        [[40, "TSH"], [250, "2.150"], [380, "uIU/mL"], [470, "0.450-4.500"]],
        [[40, "Vitamin D, 25-Hydroxy"], [250, "22.1"], [330, "L"], [380, "ng/mL"], [470, "30.0-100.0"]],
        [[40, "HIV Ag/Ab Screen"], [250, "Non Reactive"], [470, "Non Reactive"]]
      ]),
      { x: 40, y: 460, text: "Lab: Sample Reference Laboratory, 123 Main St, Springfield 62704" }
    ]
  ]);
}

// Indian lab style: investigation | observed value | unit | biological reference interval.
export function indiaStyleReport(): Uint8Array {
  return makePdf([
    [
      { x: 40, y: 40, text: "Sample Diagnostics Pvt. Ltd.", size: 14 },
      { x: 40, y: 62, text: "Name : Mr. Test Patient     Age/Sex : 45 Y / M" },
      { x: 40, y: 78, text: "Sample Collected On : 02-Aug-2026 09:30     Reported On : 02-Aug-2026 18:05" },
      ...table(120, [
        [[40, "Investigation"], [260, "Observed Value"], [360, "Unit"], [450, "Biological Ref. Interval"]],
        [[40, "COMPLETE BLOOD COUNT"]],
        [[40, "Haemoglobin"], [260, "13.2"], [360, "g/dL"], [450, "13.0 - 17.0"]],
        [[40, "Total Leucocyte Count"], [260, "7.5"], [360, "10^3/uL"], [450, "4.0 - 10.0"]],
        [[40, "Platelet Count"], [260, "145"], [360, "10^3/uL"], [450, "150 - 410"]],
        [[40, "PCV"], [260, "41.0"], [360, "%"], [450, "40 - 50"]],
        [[40, "BIOCHEMISTRY"]],
        [[40, "Fasting Blood Sugar"], [260, "112 H"], [360, "mg/dL"], [450, "70 - 100"]],
        [[40, "HbA1c"], [260, "6.1"], [360, "%"], [450, "< 5.7"]],
        [[40, "Serum Creatinine"], [260, "1.02"], [360, "mg/dL"], [450, "0.7 - 1.3"]],
        [[40, "Vitamin B12"], [260, "180 L"], [360, "pg/mL"], [450, "211 - 911"]],
        [[40, "25 OH Vitamin D"], [260, "18.4"], [360, "ng/mL"], [450, "30 - 100"]]
      ]),
      { x: 40, y: 330, text: "*** End of Report ***" }
    ]
  ]);
}
