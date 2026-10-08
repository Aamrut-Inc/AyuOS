import { expect, test } from "bun:test";
import { detectCollectedDate, parseLabRow } from "./lab-results";

const row = (text: string, index = 0) => ({ page: 1, index, cells: [text], text });

test("reads name, value, flag, unit and range in US column order", () => {
  const c = parseLabRow(row("Hemoglobin A1c  5.9  H  %  4.8-5.6"))!;
  expect(c.analyteKey).toBe("hba1c");
  expect(c.loinc).toBe("4548-4");
  expect(c.valueNum).toBe(5.9);
  expect(c.flag).toBe("H");
  expect(c.unit).toBe("%");
  expect([c.refLow, c.refHigh]).toEqual([4.8, 5.6]);
});

test("reads Indian-style rows with attached flags and spaced ranges", () => {
  const c = parseLabRow(row("Vitamin B12  180 L  pg/mL  211 - 911"))!;
  expect(c.analyteKey).toBe("vitamin_b12");
  expect(c.valueNum).toBe(180);
  expect(c.flag).toBe("L");
  expect([c.refLow, c.refHigh]).toEqual([211, 911]);
});

test("names that start with a number use the next numeric token as the value", () => {
  const c = parseLabRow(row("25 OH Vitamin D  18.4  ng/mL  30 - 100"))!;
  expect(c.analyteKey).toBe("vitamin_d_25oh");
  expect(c.valueNum).toBe(18.4);
  expect(c.flag).toBe("L"); // inferred from the range
});

test("skips LabCorp footnote numbers after the name", () => {
  const c = parseLabRow(row("Cholesterol, Total 01  212  High  mg/dL  100-199"))!;
  expect(c.analyteKey).toBe("cholesterol_total");
  expect(c.valueNum).toBe(212);
  expect(c.flag).toBe("H");
});

test("one-sided reference bounds and comparators", () => {
  const hdl = parseLabRow(row("HDL Cholesterol  45  mg/dL  >39"))!;
  expect([hdl.refLow, hdl.refHigh, hdl.flag]).toEqual([39, null, null]);
  const crp = parseLabRow(row("hs-CRP  < 0.3  mg/L  0.0-3.0"))!;
  expect(crp.comparator).toBe("<");
  expect(crp.valueNum).toBe(0.3);
});

test("normalizes OCR'd powers of ten in count units", () => {
  expect(parseLabRow(row("Platelet Count  145  1013/uL  150 - 410"))!.unit).toBe("10^3/uL");
  expect(parseLabRow(row("Total Leucocyte Count  7.5  103/µL  4.0 - 10.0"))!.unit).toBe("10^3/uL");
});

test("ratios are not mistaken for their component test", () => {
  const c = parseLabRow(row("Cholesterol/HDL Ratio  4.7  ratio  0.0-5.0"));
  expect(c?.analyteKey ?? null).toBeNull();
});

test("ignores header, demographic and address rows", () => {
  for (const text of [
    "TEST  RESULT  FLAG  UNITS  REFERENCE INTERVAL",
    "Patient: TEST, PATIENT  DOB: 01/01/1980",
    "Name : Mr. Test Patient  Age/Sex : 45 Y / M",
    "Lab: Sample Reference Laboratory, 123 Main St, Springfield 62704",
    "Ordering Physician: Example, MD  Phone: 555-123-4567",
    "Page 1 of 3"
  ]) {
    expect(parseLabRow(row(text))).toBeNull();
  }
});

test("collected date: keyword wins, birth dates are skipped, day-first is detected", () => {
  expect(detectCollectedDate([row("DOB: 01/01/1980"), row("Date Collected: 03/14/2026 08:12")])).toBe("2026-03-14");
  expect(detectCollectedDate([row("Reported: 03/15/2026  Collected: 03/14/2026")])).toBe("2026-03-14");
  expect(detectCollectedDate([row("Sample Collected On : 02-Aug-2026 09:30")])).toBe("2026-08-02");
  expect(detectCollectedDate([row("Collected: 05/04/2026"), row("Reported: 25/04/2026")])).toBe("2026-04-05");
  expect(detectCollectedDate([row("no dates here")])).toBeNull();
});
