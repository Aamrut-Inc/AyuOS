import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";

// Builds the evaluation databases (section 18.1): one database per synthetic
// persona on the same embedded server, filled through the app's own import
// code (RawFhirStore + runTransform, the Oura/Whoop mappers, AttachmentStore,
// the lab PDF parser and review step), then the agent jobs.
//
//   bun agent/eval/synth/build.ts            all personas
//   bun agent/eval/synth/build.ts p01 p05    some
//
// Files the app writes (attachments, lab PDFs, the compiled PDF reader) go to
// agent/eval/.data, never the person's data folder.
export const EVAL_DATA_DIR = join(import.meta.dir, "..", ".data");
process.env.AYUOS_DATA_DIR = EVAL_DATA_DIR;

const { loadPostgresConfig } = await import("../../../load/config");
const { ensureDatabase } = await import("../../../load/database");
const { runMigrations } = await import("../../../load/migrate");
const { RawFhirStore } = await import("../../../load/raw-store");
const { runTransform } = await import("../../../transform/run");
const { AttachmentStore } = await import("../../../load/attachment-store");
const { EhrConnectionStore } = await import("../../../load/ehr-connections");
const { WearableRecordStore } = await import("../../../load/wearable-records");
const { TimeseriesStore } = await import("../../../load/timeseries");
const { LabStore } = await import("../../../load/lab-store");
const { importLabPdf } = await import("../../../app/lab-import");
const { OURA_TYPES } = await import("../../../extract/wearables/oura");
const { WHOOP_TYPES } = await import("../../../extract/wearables/whoop");
const { readingCollector } = await import("../../../extract/wearables/readings");
const { setSetting } = await import("../../db");
const { rebuildTzHistory } = await import("../../jobs/tz-history");
const { refreshWearableDaily } = await import("../../jobs/index");
const { extractNotes } = await import("../../jobs/notes");
const { generateFhir, labReportPdfs } = await import("./fhir");
const { generateWearables } = await import("./wearables");
const { DAYS, END_DAY, HOSPITAL, IMPORT_DAY, PERSONAS, SANDBOX, evalDbName, persona } = await import("./personas");
const { addDays } = await import("../../context/timezone");
type Persona = import("./personas").Persona;

const USER_ID = "me";
// The instant the synthetic year ends: the morning after END_DAY, UTC.
export const EVAL_NOW = new Date(`${addDays(END_DAY, 1)}T16:00:00Z`);

export function evalConnectionString(id: string): string {
  const url = new URL(loadPostgresConfig().connectionString);
  url.pathname = `/${evalDbName(id)}`;
  return url.toString();
}

async function recreateDatabase(name: string): Promise<void> {
  const admin = new SQL(loadPostgresConfig().connectionString);
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await admin.unsafe(`ALTER DATABASE ${name} SET timezone TO 'UTC'`);
  } finally {
    await admin.close();
  }
}

async function loadWearables(config: { connectionString: string }, p: Persona) {
  const generated = generateWearables(p);
  const records = new WearableRecordStore(config);
  const timeseries = new TimeseriesStore(config);
  try {
    const save = async (provider: "oura" | "whoop", types: typeof OURA_TYPES, docs: Record<string, any[]>) => {
      for (const [name, items] of Object.entries(docs)) {
        if (items.length === 0) continue;
        const spec = types.find((t) => t.name === name)!;
        if (spec.record) await records.upsert(provider, name, items.map(spec.record));
        const { readings, push } = readingCollector(USER_ID, provider);
        spec.readings(items, push, EVAL_NOW);
        for (let i = 0; i < readings.length; i += 2000) await timeseries.upsertReadings(readings.slice(i, i + 2000));
      }
    };
    await save("oura", OURA_TYPES, generated.oura);
    await save("whoop", WHOOP_TYPES, generated.whoop);
    const apple = generated.appleReadings.map((r) => ({
      userId: USER_ID, metricType: r.metricType, ts: r.ts, value: r.value, unit: r.unit, sourceProvider: "apple_health", sourceDevice: null, context: null
    }));
    for (let i = 0; i < apple.length; i += 2000) await timeseries.upsertReadings(apple.slice(i, i + 2000));
  } finally {
    await records.close();
    await timeseries.close();
  }
  return generated.truth;
}

async function loadHospital(config: { connectionString: string }, p: Persona) {
  const fhir = generateFhir(p);
  const connections = new EhrConnectionStore(config);
  const raw = new RawFhirStore(config);
  const attachments = new AttachmentStore(config);
  try {
    await connections.add(HOSPITAL.name, HOSPITAL.url, false, HOSPITAL.slug);
    await connections.add(SANDBOX.name, SANDBOX.url, true, SANDBOX.slug);
    for (const r of fhir.real) await raw.upsertResource(r as any, `pat-${p.id}`, HOSPITAL.slug);
    for (const r of fhir.sandbox) await raw.upsertResource(r as any, "sandbox-pat", SANDBOX.slug);
    for (const r of fhir.updates) await raw.upsertResource(r as any, `pat-${p.id}`, HOSPITAL.slug);
    await runTransform(config);
    for (const a of fhir.attachments) {
      await attachments.save(HOSPITAL.slug, {
        ref: { resourceType: a.resourceType, resourceId: a.resourceId, url: `Binary/${a.resourceId}-bin`, inlineData: null, contentType: a.contentType, title: a.title },
        bytes: a.bytes,
        contentType: a.contentType,
        error: null
      });
    }
  } finally {
    await connections.close();
    await raw.close();
    await attachments.close();
  }
}

// Through the real parser; then the review: the outside report is confirmed
// except its last row (rejected); p01's portal printout stays pending (T3).
async function loadLabPdfs(config: { connectionString: string }, p: Persona) {
  const store = new LabStore(config);
  try {
    for (const [i, report] of labReportPdfs(p).entries()) {
      const { documentId } = await importLabPdf(config, report.filename, report.bytes);
      if (p.id === "p01" && i === 1) continue;
      const rows = await store.resultsForDocument(documentId);
      await store.saveReview(
        documentId,
        report.collected,
        rows.map((row, k) => ({
          id: row.id,
          accept: !(i === 0 && k === rows.length - 1),
          analyteName: row.analyte_name,
          valueNum: row.value_num,
          valueText: row.value_text,
          comparator: row.comparator,
          unit: row.unit,
          refText: row.ref_text,
          refLow: row.ref_low,
          refHigh: row.ref_high,
          flag: row.flag
        }))
      );
    }
  } finally {
    await store.close();
  }
}

async function bookkeeping(sql: SQL, p: Persona) {
  const importAt = `${IMPORT_DAY}T18:00:00Z`;
  for (const slug of [HOSPITAL.slug, SANDBOX.slug]) {
    await sql`INSERT INTO ops.sync_runs (job, trigger, status, started_at, finished_at, detail)
              VALUES (${`ehr-import:${slug}`}, 'connect', 'success', ${importAt}, ${importAt}, '{}'::jsonb)`;
  }
  const end = EVAL_NOW.toISOString();
  const whoopEnd = p.id === "p01" ? `${addDays(END_DAY, -32)}T15:00:00Z` : end;
  for (const provider of p.providers.filter((x) => x !== "apple_health")) {
    const stale = provider === "whoop" && p.id === "p01";
    await sql`
      INSERT INTO ops.wearable_connections (provider, access_token_enc, status, last_synced_at, last_error)
      VALUES (${provider}, 'synthetic', ${stale ? "needs_reconnect" : "active"}, ${stale ? whoopEnd : end},
              ${stale ? "Whoop: login expired (synthetic)" : null})
    `;
    await sql`INSERT INTO ops.sync_runs (job, trigger, status, started_at, finished_at, detail)
              VALUES (${`wearables-${provider}`}, 'schedule', 'success', ${stale ? whoopEnd : end}, ${stale ? whoopEnd : end}, '{}'::jsonb)`;
  }
  if (p.providers.includes("apple_health")) {
    await sql`INSERT INTO ops.sync_runs (job, trigger, status, started_at, finished_at, detail)
              VALUES ('apple-health-upload', 'manual', 'success', ${`${END_DAY}T20:00:00Z`}, ${`${END_DAY}T20:00:00Z`}, '{}'::jsonb)`;
  }
}

export async function buildPersona(id: string, log = console.log): Promise<void> {
  const p = persona(id);
  const started = performance.now();
  const name = evalDbName(id);
  await recreateDatabase(name);
  const config = { connectionString: evalConnectionString(id) };
  await runMigrations(config, false);
  await loadHospital(config, p);
  const truth = await loadWearables(config, p);
  await loadLabPdfs(config, p);

  const sql = new SQL(config.connectionString);
  try {
    await bookkeeping(sql, p);
    // The persona's zone is pinned (source 'user') so runs don't depend on the Mac's.
    await setSetting(sql, "timezone", p.tz, "user");
    await setSetting(sql, "include_sandbox", false, "app");
    await rebuildTzHistory(sql, EVAL_NOW);
    const refresh = await refreshWearableDaily(sql);
    const notes = await extractNotes(sql);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM timeseries.readings`;
    const dir = join(EVAL_DATA_DIR, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "truth.json"), JSON.stringify({ persona: p, days: DAYS, end_day: END_DAY, now: EVAL_NOW.toISOString(), wearable_days: truth }, null, 1));
    log(`${id} (${p.profile}): ${n} readings, notes ${notes.extracted}/${notes.attempted}, daily view ${refresh.ms} ms, total ${Math.round(performance.now() - started)} ms`);
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  await ensureDatabase();
  const ids = process.argv.slice(2);
  for (const id of ids.length ? ids : PERSONAS.map((p) => p.id)) await buildPersona(id);
}
