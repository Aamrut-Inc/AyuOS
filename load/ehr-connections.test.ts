import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { EhrConnectionStore, slugFor } from "./ehr-connections";
import { loadPostgresConfig } from "./config";

const config = loadPostgresConfig();
const sql = new SQL(config.connectionString);
const store = new EhrConnectionStore(config);
const tag = crypto.randomUUID().slice(0, 8);

afterAll(async () => {
  await sql`DELETE FROM ops.ehr_connections WHERE fhir_base_url LIKE ${`https://test-${tag}%`}`;
  await sql.close();
  await store.close();
});

test("slugs are short, lowercase and stable", () => {
  expect(slugFor("Stanford Health Care")).toBe("stanford_health_care");
  expect(slugFor("Kaiser – NCAL - prod 326 (CIS)")).toBe("kaiser_ncal_prod_326_cis");
  expect(slugFor("!!!")).toBe("hospital");
});

test("adding the same address twice returns the existing hospital; names get unique slugs", async () => {
  const name = `Test Hospital ${tag}`;
  const a = await store.add(name, `https://test-${tag}-a.example.com/FHIR/R4/`, false);
  const again = await store.add(name, `https://test-${tag}-a.example.com/FHIR/R4`, false);
  const b = await store.add(name, `https://test-${tag}-b.example.com/FHIR/R4`, false);
  expect(again).toBe(a);
  expect(b).toBe(`${a}_2`);
  const listed = (await store.list()).filter((c) => c.fhirBaseUrl.includes(tag));
  expect(listed.map((c) => c.fhirBaseUrl)).toEqual([
    `https://test-${tag}-a.example.com/FHIR/R4`,
    `https://test-${tag}-b.example.com/FHIR/R4`
  ]);
});
