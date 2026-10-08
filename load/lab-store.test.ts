import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { LabStore } from "./lab-store";
import { loadPostgresConfig } from "./config";
import type { LabResultCandidate } from "../transform/lab-results";

const config = loadPostgresConfig();
const sql = new SQL(config.connectionString);
const store = new LabStore(config);
const sha = `test-${crypto.randomUUID()}`;

function candidate(rowIndex: number, analyteName: string, valueNum: number): LabResultCandidate {
  return {
    page: 1, rowIndex, sourceText: `${analyteName} ${valueNum}`, analyteName, analyteKey: null, loinc: null,
    valueNum, valueText: null, comparator: null, unit: "mg/dL", refLow: null, refHigh: null, refText: null,
    flag: null, confidence: 0.9
  };
}

afterAll(async () => {
  await sql`DELETE FROM labs.documents WHERE sha256 = ${sha}`;
  await sql.close();
  await store.close();
});

test("review confirms/rejects rows; re-reading keeps them and the reviewed status", async () => {
  const id = await store.createDocument({ sha256: sha, filename: "t.pdf", filePath: "/dev/null", sizeBytes: 1 });
  await store.saveExtraction(id, { pageCount: 1, method: "text", collectedDate: "2026-08-02" }, [
    candidate(1, "Glucose", 104),
    candidate(2, "Sodium", 139)
  ]);
  expect((await store.getDocument(id))!.collected_date).toBe("2026-08-02");

  const [glucose, sodium] = await store.resultsForDocument(id);
  const review = (r: typeof glucose, accept: boolean, valueNum: number) => ({
    id: r.id, accept, analyteName: r.analyte_name, valueNum, valueText: null, comparator: null,
    unit: r.unit, refText: null, refLow: null, refHigh: null, flag: null
  });
  await store.saveReview(id, "2026-08-03", [review(glucose, true, 105), review(sodium, false, 139)]);

  await store.saveExtraction(id, { pageCount: 1, method: "text", collectedDate: "2026-08-02" }, [
    candidate(1, "Glucose", 104),
    candidate(2, "Sodium", 139)
  ]);
  const doc = (await store.getDocument(id))!;
  expect(doc.status).toBe("reviewed");
  expect(doc.collected_date).toBe("2026-08-03");
  const rows = await store.resultsForDocument(id);
  expect(rows.map((r) => [r.analyte_name, r.value_num, r.status, r.collected_date])).toEqual([
    ["Glucose", 105, "confirmed", "2026-08-03"],
    ["Sodium", 139, "rejected", "2026-08-03"]
  ]);
});
