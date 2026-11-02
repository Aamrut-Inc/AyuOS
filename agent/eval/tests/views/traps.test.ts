import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { ensureEvalDb, withSandbox } from "../helpers";

// Section 4.7: one test per handbook trap, against the synthetic persona
// databases where every trap was planted on purpose (agent/eval/synth).

let p01: SQL;
let p07: SQL;
let p10: SQL;

beforeAll(async () => {
  p01 = await ensureEvalDb("p01");
  p07 = await ensureEvalDb("p07");
  p10 = await ensureEvalDb("p10");
}, 300_000);

afterAll(async () => {
  await Promise.all([p01?.close(), p07?.close(), p10?.close()]);
});

const count = async (sql: SQL, query: string) => Number((await sql.unsafe(query))[0].n);

describe("handbook traps", () => {
  test("T1 sandbox rows absent by default, present with include_sandbox", async () => {
    const hidden = `SELECT count(*) n FROM (
      SELECT source FROM agent.v_lab_results UNION ALL SELECT source FROM agent.v_conditions
      UNION ALL SELECT source FROM agent.v_prescriptions) s WHERE source = 'epic_sandbox'`;
    expect(await count(p01, hidden)).toBe(0);
    expect((await p01`SELECT hospitals FROM agent.v_profile`)[0].hospitals.map((h: any) => h.source)).toEqual(["valley_general"]);
    await withSandbox(p01, async () => {
      expect(await count(p01, hidden)).toBe(3);
    });
  });

  test("T2 only current versions (the amended result replaces the original)", async () => {
    const rows = await p01`SELECT result_key FROM agent.v_lab_results WHERE result_key = 'obs:valley_general:obs-p01-2276-4-3'`;
    expect(rows.length).toBe(1);
    expect(await count(p01, `SELECT count(*) n FROM clinical.fhir_resources WHERE resource_id = 'obs-p01-2276-4-3' AND source = 'valley_general'`)).toBe(2);
  });

  test("T3 only confirmed lab PDF rows", async () => {
    const confirmed = await count(p01, `SELECT count(*) n FROM labs.results WHERE status = 'confirmed'`);
    const others = await count(p01, `SELECT count(*) n FROM labs.results WHERE status <> 'confirmed'`);
    expect(others).toBeGreaterThan(0); // pending and rejected rows exist
    expect(await count(p01, `SELECT count(*) n FROM agent.v_lab_results WHERE origin = 'pdf'`)).toBe(confirmed);
  });

  test("T4/T6 no view merges metrics from different comparable groups", async () => {
    // Daily aggregates are keyed by provider and metric; recovery and sleep
    // keep provider-named columns that are never both filled on one row.
    const dupKeys = await count(p01, `SELECT count(*) n FROM (SELECT source_provider, metric_type, local_day FROM agent.v_wearable_daily GROUP BY 1,2,3 HAVING count(*) > 1) d`);
    expect(dupKeys).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_recovery_daily WHERE oura_readiness_score IS NOT NULL AND whoop_recovery_score IS NOT NULL`)).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_recovery_daily WHERE provider = 'oura' AND whoop_hrv_rmssd_ms IS NOT NULL`)).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_sleep_sessions WHERE oura_efficiency_pct IS NOT NULL AND whoop_efficiency_pct IS NOT NULL`)).toBe(0);
    const groups = await p01`SELECT comparable_group FROM agent.metric_catalog WHERE (metric_type, source_provider) IN (('heart_rate_variability_sdnn','oura'), ('heart_rate_variability_rmssd','whoop'))`;
    expect(new Set(groups.map((g: any) => g.comparable_group)).size).toBe(2);
  });

  test("T5 an Oura day anchored at 00:00 UTC stays on its own day west of UTC", async () => {
    const rows = await p01`
      SELECT d.local_day::text AS day, d.mean, (r.json ->> 'score')::float AS score
      FROM agent.v_wearable_daily d
      JOIN wearables.records r ON r.provider = 'oura' AND r.data_type = 'daily_sleep' AND r.is_current AND r.day = d.local_day
      WHERE d.source_provider = 'oura' AND d.metric_type = 'sleep_score'`;
    expect(rows.length).toBeGreaterThan(300);
    for (const row of rows) expect(row.mean).toBe(row.score);
    // and nothing was moved to a day without a record
    const orphan = await count(p01, `SELECT count(*) n FROM agent.v_wearable_daily d WHERE d.source_provider = 'oura' AND d.metric_type = 'sleep_score'
      AND NOT EXISTS (SELECT 1 FROM wearables.records r WHERE r.provider = 'oura' AND r.data_type = 'daily_sleep' AND r.day = d.local_day)`);
    expect(orphan).toBe(0);
  });

  test("T8 ordinals come with labels and are never averaged", async () => {
    const labels = await p01`SELECT DISTINCT value_label FROM agent.v_readings
      WHERE metric_type = 'sleep_stage' AND source_provider = 'oura' AND ts >= '2026-10-01' AND ts < '2026-10-08'`;
    expect(new Set(labels.map((l: any) => l.value_label))).toEqual(new Set(["deep", "light", "REM", "awake"]));
    const averaged = await count(p01, `SELECT count(*) n FROM agent.v_wearable_daily WHERE metric_type IN ('sleep_stage', 'activity_class', 'workout_intensity') AND (mean IS NOT NULL OR median IS NOT NULL OR sum IS NOT NULL)`);
    expect(averaged).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_wearable_daily WHERE metric_type = 'sleep_stage' AND value_counts IS NOT NULL`)).toBeGreaterThan(300);
  });

  test("T9 sync-time snapshots are flagged", async () => {
    const rows = await p01`SELECT source_provider, metric_type, bool_and(is_sync_time) AS flagged FROM agent.v_wearable_daily
      WHERE (metric_type IN ('weight', 'height') AND source_provider IN ('oura', 'whoop')) GROUP BY 1, 2`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.flagged).toBe(true);
    expect((await p01`SELECT bool_or(is_sync_time) AS f FROM agent.v_wearable_daily WHERE metric_type = 'weight' AND source_provider = 'apple_health'`)[0].f).toBe(false);
  });

  test("T10 blood pressure from components; values and ranges from raw JSON", async () => {
    const bp = await p01`SELECT vital, value_num FROM agent.v_vitals WHERE vital IN ('systolic_bp', 'diastolic_bp') ORDER BY effective_at, vital`;
    expect(bp.length).toBe(6);
    expect(bp[0]).toEqual({ vital: "diastolic_bp", value_num: 72 });
    const json = await p01`SELECT value_text, ref_text FROM agent.v_lab_results WHERE loinc_code = '5196-1'`;
    expect(json[0]).toEqual({ value_text: "Negative", ref_text: "Negative" });
    expect(await count(p01, `SELECT count(*) n FROM agent.v_lab_results WHERE origin = 'hospital' AND value_num IS NOT NULL AND ref_high IS NULL AND ref_low IS NULL`)).toBe(0);
  });

  test("T11-T13 unresolved links keep rows; ids matched per source", async () => {
    const report = await p01`SELECT result_keys FROM agent.v_reports WHERE report_key = 'rep:valley_general:rep-p01-0'`;
    expect(report[0].result_keys).toContain(null);
    expect(report[0].result_keys.filter((k: string | null) => k !== null).length).toBeGreaterThan(5);
    // The observation whose encounter is missing is still a result.
    expect(await count(p01, `SELECT count(*) n FROM agent.v_lab_results WHERE result_key = 'obs:valley_general:obs-p01-2276-4-0'`)).toBe(1);
    await withSandbox(p01, async () => {
      const same = await p01`SELECT source, value_num FROM agent.v_lab_results WHERE result_key LIKE 'obs:%:obs-p01-2276-4-0' ORDER BY source`;
      expect(same.map((r: any) => r.source)).toEqual(["epic_sandbox", "valley_general"]);
      expect(same[0].value_num).not.toBe(same[1].value_num);
    });
  });

  test("T15 NULL context is unknown, not excluded", async () => {
    const nulls = await count(p01, `SELECT count(*) n FROM agent.v_readings WHERE metric_type = 'heart_rate' AND source_provider = 'oura' AND context IS NULL AND ts >= '2025-11-05' AND ts < '2025-11-06'`);
    expect(nulls).toBeGreaterThan(100);
    const day = await p01`SELECT n FROM agent.v_wearable_daily WHERE source_provider = 'oura' AND metric_type = 'heart_rate' AND local_day = '2025-11-05'`;
    expect(day[0].n).toBeGreaterThanOrEqual(nulls);
  });

  test("T16 a needs_reconnect source shows in v_data_freshness", async () => {
    const [whoop] = await p01`SELECT status, last_error FROM agent.v_data_freshness WHERE source = 'whoop'`;
    expect(whoop.status).toBe("needs_reconnect");
  });

  test("T17 one main sleep per provider-day, naps counted", async () => {
    expect(await count(p01, `SELECT count(*) n FROM (SELECT provider, day FROM agent.v_sleep_nights GROUP BY 1, 2 HAVING count(*) > 1) d`)).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_sleep_nights WHERE nap_count > 0`)).toBeGreaterThan(20);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_sleep_sessions WHERE NOT is_main`)).toBeGreaterThan(20);
  });

  test("T18 excluded statuses are absent", async () => {
    expect(await count(p01, `SELECT count(*) n FROM agent.v_conditions WHERE verification_status IN ('entered-in-error', 'refuted')`)).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_conditions WHERE name LIKE '%ENTERED IN ERROR%' OR name LIKE '%ruled out%'`)).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_prescriptions WHERE status IN ('cancelled', 'entered-in-error')`)).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_immunizations WHERE vaccine = 'Hepatitis B vaccine'`)).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_lab_results WHERE result_key = 'obs:valley_general:obs-p01-eie'`)).toBe(0);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_encounters WHERE status = 'cancelled'`)).toBe(0);
  });

  test("T19 prescriptions carry the meaning column", async () => {
    const rows = await p01`SELECT DISTINCT meaning FROM agent.v_prescriptions`;
    expect(rows).toEqual([{ meaning: "prescribed, not confirmed as taken" }]);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_medication_statements WHERE not_taken`)).toBe(1);
  });

  test("T20 panels are not counted as results", async () => {
    expect(await count(p01, `SELECT count(*) n FROM agent.v_lab_results WHERE loinc_code = '57698-3'`)).toBe(0);
  });

  test("T21 every category spelling is caught", async () => {
    const generated = await count(p01, `SELECT count(*) n FROM clinical.observation o JOIN clinical.fhir_resources f ON f.id = o.fhir_resource_id
      WHERE o.source = 'valley_general' AND o.category_codes && ARRAY['laboratory', 'Lab', 'LAB'] AND o.status <> 'entered-in-error' AND cardinality(coalesce(o.has_member_refs, '{}')) = 0`);
    expect(await count(p01, `SELECT count(*) n FROM agent.v_lab_results WHERE origin = 'hospital'`)).toBe(generated);
    const spellings = await p01`SELECT DISTINCT unnest(category_codes) AS c FROM clinical.observation WHERE source = 'valley_general' AND category_codes && ARRAY['laboratory', 'Lab', 'LAB']`;
    expect(new Set(spellings.map((s: any) => s.c))).toEqual(new Set(["laboratory", "Lab", "LAB"]));
  });

  test("T22/T23 PDF rows: suggested codes and document-level dates", async () => {
    const rows = await p01`SELECT DISTINCT code_confidence, effective_precision FROM agent.v_lab_results WHERE origin = 'pdf'`;
    for (const r of rows) {
      expect(["suggested", "none"]).toContain(r.code_confidence);
      expect(r.effective_precision).toBe("document_date");
    }
    // Possible duplicates: p07's portal printout repeats hospital values.
    const dups = await p07`SELECT count(*)::int AS n FROM agent.v_lab_results WHERE possible_duplicate_of IS NOT NULL`;
    expect(dups[0].n).toBeGreaterThan(0);
  });

  test("T24 no identifier column in any agent view", async () => {
    const cols = await p01`
      SELECT c.table_name, c.column_name FROM information_schema.columns c
      JOIN information_schema.views v ON v.table_schema = c.table_schema AND v.table_name = c.table_name
      WHERE c.table_schema = 'agent'
        AND c.column_name ~* '(given|family_name|^family$|birth|address|phone|email|mrn|identifier|telecom|first_name|last_name|patient_name)'`;
    expect(cols).toEqual([]);
    // and the planted identifiers appear in no view's text
    const leaks = await count(p01, `SELECT count(*) n FROM agent.v_fhir_other WHERE json::text ~* '(Quintrell|Marisol|VG-4471902|1988-04-17)'`);
    expect(leaks).toBe(0);
  });

  test("data red flag: critical interpretation codes are exposed", async () => {
    const rows = await p10`SELECT test_name, flag, critical FROM agent.v_lab_results WHERE critical`;
    expect(rows).toEqual([{ test_name: "Troponin T, cardiac", flag: "H", critical: true }]);
  });

  test("catalog covers every metric in readings", async () => {
    for (const sql of [p01, p07, p10]) {
      expect(await count(sql, `SELECT count(*) n FROM (SELECT DISTINCT metric_type, source_provider FROM timeseries.readings) r
        WHERE NOT EXISTS (SELECT 1 FROM agent.metric_catalog c WHERE c.metric_type = r.metric_type AND c.source_provider = r.source_provider)`)).toBe(0);
    }
  });

  test("typical view queries return in under 2 seconds on 12 months of dense heart rate", async () => {
    const queries = [
      `SELECT * FROM agent.v_wearable_daily WHERE source_provider = 'oura' AND metric_type = 'heart_rate' AND local_day >= '2025-11-01'`,
      `SELECT * FROM agent.v_readings WHERE source_provider = 'oura' AND metric_type = 'heart_rate' AND ts >= '2026-10-01' AND ts < '2026-11-01'`,
      `SELECT * FROM agent.v_sleep_nights WHERE day >= '2025-11-01'`,
      `SELECT * FROM agent.v_lab_results`,
      `SELECT * FROM agent.v_recovery_daily`,
      `SELECT * FROM agent.v_data_freshness`,
      `SELECT * FROM agent.v_metric_catalog`
    ];
    for (const q of queries) {
      const started = performance.now();
      await p01.unsafe(q);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});
