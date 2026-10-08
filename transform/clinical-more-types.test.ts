import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { loadPostgresConfig } from "../load/config";
import { RawFhirStore } from "../load/raw-store";
import type { FhirResource } from "../shared/types";
import { transformCondition } from "./condition";
import { transformMedicationRequest } from "./medication-request";
import { transformAllergyIntolerance } from "./allergy-intolerance";
import { transformEncounter } from "./encounter";

const config = loadPostgresConfig();
const sql = new SQL(config.connectionString);
const store = new RawFhirStore(config);
const source = `test-${crypto.randomUUID()}`;

async function load(resource: FhirResource, mapper: typeof transformCondition): Promise<void> {
  await store.upsertResource(resource, "pat-1", source);
  const [row] = await sql`
    SELECT id, content_hash FROM clinical.fhir_resources
    WHERE source = ${source} AND resource_id = ${resource.id} AND is_current
  `;
  await mapper(sql, row.id, source, resource, row.content_hash);
}

afterAll(async () => {
  for (const table of ["condition", "medication_request", "allergy_intolerance", "encounter"]) {
    await sql.unsafe(`DELETE FROM clinical.${table} WHERE source = $1`, [source]);
  }
  await sql`DELETE FROM clinical.fhir_resources WHERE source = ${source}`;
  await sql.close();
  await store.close();
});

test("Condition: status, categories, codes, partial onset date", async () => {
  await load(
    {
      resourceType: "Condition",
      id: "cond-1",
      clinicalStatus: { coding: [{ code: "active" }] },
      verificationStatus: { coding: [{ code: "confirmed" }] },
      category: [{ coding: [{ code: "problem-list-item" }] }],
      code: {
        text: "Essential hypertension",
        coding: [{ system: "http://snomed.info/sct", code: "59621000", display: "Essential hypertension" }]
      },
      subject: { reference: "Patient/pat-1" },
      onsetDateTime: "2019-05"
    },
    transformCondition
  );
  const [row] = await sql`SELECT * FROM clinical.condition WHERE source = ${source}`;
  expect([row.clinical_status, row.code_text, row.onset_text, row.patient_id]).toEqual([
    "active", "Essential hypertension", "2019-05", "pat-1"
  ]);
  expect(row.category_codes).toEqual(["problem-list-item"]);
  expect(new Date(row.onset_datetime).toISOString().slice(0, 7)).toBe("2019-05");
  const codes = await sql`SELECT code FROM clinical.condition_coding WHERE condition_id = ${row.id}`;
  expect(codes.map((c: any) => c.code)).toEqual(["59621000"]);
});

test("MedicationRequest: medication by reference display, dosage text", async () => {
  await load(
    {
      resourceType: "MedicationRequest",
      id: "med-1",
      status: "active",
      intent: "order",
      medicationReference: { reference: "Medication/m1", display: "lisinopril 10 MG tablet" },
      subject: { reference: "Patient/pat-1" },
      authoredOn: "2024-02-11",
      dosageInstruction: [{ text: "Take 1 tablet by mouth daily" }],
      reasonCode: [{ text: "Hypertension" }]
    },
    transformMedicationRequest
  );
  const [row] = await sql`SELECT * FROM clinical.medication_request WHERE source = ${source}`;
  expect([row.medication_text, row.dosage_text, row.medication_ref]).toEqual([
    "lisinopril 10 MG tablet", "Take 1 tablet by mouth daily", "Medication/m1"
  ]);
  expect(row.reason_text).toEqual(["Hypertension"]);
});

test("AllergyIntolerance: substance, reactions, severities", async () => {
  await load(
    {
      resourceType: "AllergyIntolerance",
      id: "alg-1",
      clinicalStatus: { coding: [{ code: "active" }] },
      type: "allergy",
      category: ["medication"],
      criticality: "high",
      code: { coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "7980", display: "Penicillin G" }] },
      patient: { reference: "Patient/pat-1" },
      reaction: [{ manifestation: [{ text: "Hives" }], severity: "moderate" }]
    },
    transformAllergyIntolerance
  );
  const [row] = await sql`SELECT * FROM clinical.allergy_intolerance WHERE source = ${source}`;
  expect([row.substance_text, row.criticality, row.patient_id]).toEqual(["Penicillin G", "high", "pat-1"]);
  expect(row.reactions).toEqual(["Hives"]);
  expect(row.reaction_severities).toEqual(["moderate"]);
});

test("Encounter: class, type, period, location, re-run is idempotent", async () => {
  const encounter = {
    resourceType: "Encounter",
    id: "enc-1",
    status: "finished",
    class: { code: "AMB", display: "ambulatory" },
    type: [{ text: "Office Visit", coding: [{ system: "urn:epic", code: "101", display: "Office Visit" }] }],
    subject: { reference: "Patient/pat-1" },
    period: { start: "2025-11-03T09:00:00Z", end: "2025-11-03T09:30:00Z" },
    serviceProvider: { display: "Example Primary Care" },
    location: [{ location: { display: "Example Clinic, Floor 2" } }]
  };
  await load(encounter, transformEncounter);
  await load(encounter, transformEncounter);
  const rows = await sql`SELECT * FROM clinical.encounter WHERE source = ${source}`;
  expect(rows.length).toBe(1);
  expect([rows[0].class_code, rows[0].service_provider_name]).toEqual(["AMB", "Example Primary Care"]);
  expect(rows[0].type_text).toEqual(["Office Visit"]);
  expect(rows[0].location_names).toEqual(["Example Clinic, Floor 2"]);
  const codes = await sql`SELECT count(*)::int AS n FROM clinical.encounter_type_coding WHERE encounter_id = ${rows[0].id}`;
  expect(codes[0].n).toBe(1);
});
