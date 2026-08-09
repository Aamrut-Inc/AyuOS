import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { RawFhirStore } from "./raw-store";
import { loadPostgresConfig } from "./config";

const config = loadPostgresConfig();
const sql = new SQL(config.connectionString);
const store = new RawFhirStore(config);

const testSource = `test-${crypto.randomUUID()}`;

async function currentRows(resourceId: string) {
  return sql`
    SELECT version, is_current, content_hash
    FROM clinical.fhir_resources
    WHERE source = ${testSource} AND resource_id = ${resourceId}
    ORDER BY version
  `;
}

afterAll(async () => {
  await sql`DELETE FROM clinical.fhir_resources WHERE source = ${testSource}`;
  await sql.close();
  await store.close();
});

test("first insert creates version 1, current", async () => {
  await store.upsertResource(
    { resourceType: "Patient", id: "p1", name: [{ text: "Original" }] },
    "p1",
    testSource
  );

  const rows = await currentRows("p1");
  expect(rows.length).toBe(1);
  expect(rows[0].version).toBe(1);
  expect(rows[0].is_current).toBe(true);
});

test("re-upserting identical content is a no-op (idempotent)", async () => {
  await store.upsertResource(
    { resourceType: "Patient", id: "p1", name: [{ text: "Original" }] },
    "p1",
    testSource
  );

  const rows = await currentRows("p1");
  expect(rows.length).toBe(1);
  expect(rows[0].version).toBe(1);
});

test("upserting changed content appends a new version", async () => {
  await store.upsertResource(
    { resourceType: "Patient", id: "p1", name: [{ text: "Changed" }] },
    "p1",
    testSource
  );

  const rows = await currentRows("p1");
  expect(rows.length).toBe(2);
  expect(rows[0].is_current).toBe(false);
  expect(rows[1].version).toBe(2);
  expect(rows[1].is_current).toBe(true);
});
