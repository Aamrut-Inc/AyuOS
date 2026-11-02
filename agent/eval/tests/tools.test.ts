import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { openAgentDb, type AgentDb } from "../../db";
import { buildTurnContext } from "../../context/builder";
import { PrivacyGuard, loadIdentifiers } from "../../gateway/privacy";
import { TurnLog } from "../../runtime/turn-log";
import { TOOLS, runTool, type ToolContext } from "../../tools/index";
import { EVAL_NOW } from "../synth/build";
import { persona } from "../synth/personas";
import { generateWearables } from "../synth/wearables";
import { ensureEvalDb, evalUrl } from "./helpers";

// Section 18.2: one or more tests per tool, exact expected output. Expected
// values come from the synthetic generator's ground truth or from the raw
// tables, never from the agent views under test.

let main: SQL;
let db: AgentDb;
let t: ToolContext;
const p = persona("p01");
const truth = generateWearables(p).truth;
const tested = new Set<string>();

async function run(name: string, input: unknown) {
  tested.add(name);
  return runTool(name, input, t);
}

beforeAll(async () => {
  main = await ensureEvalDb("p01");
  db = await openAgentDb({ connectionString: evalUrl("p01") });
  const ctx = await buildTurnContext({ ro: db.ro, rw: db.rw, main: db.main, now: EVAL_NOW, recordMacZone: false }, null, "test");
  t = { ro: db.ro, log: new TurnLog(null, null), ctx, guard: new PrivacyGuard(await loadIdentifiers(db.main)) };
}, 300_000);

afterAll(async () => {
  await db?.close();
  await main?.close();
});

describe("lookup tools", () => {
  test("search_lab_tests resolves names and aliases to codes", async () => {
    const ldl = await run("search_lab_tests", { query: "LDL" });
    expect(ldl.rows.map((r) => r.loinc_code)).toContain("13457-7");
    const sugar = await run("search_lab_tests", { query: "ferritin" });
    expect(sugar.rows[0]).toMatchObject({ loinc_code: "2276-4" });
    expect(sugar.rows[0]!.results).toBe(4 + 1); // 4 hospital + 1 confirmed PDF
    const none = await run("search_lab_tests", { query: "PSA" });
    expect(none.rows).toEqual([]);
    expect(none.searched.sources.join(" ")).toContain("Valley General Hospital (synthetic) (imported 15 Oct 2026)");
    expect(none.evidence_id).toMatch(/^e\d+$/);
  });

  test("get_lab_results returns every result newest first, with range and flag", async () => {
    const r = await run("get_lab_results", { loinc_codes: ["2276-4"], analyte_key: null, from: null, to: null, origin: "hospital" });
    expect(r.rows.map((x) => [x.date, x.value_num, x.flag])).toEqual([
      ["2026-08-25", 61, "N"], ["2026-05-12", 52, "N"], ["2026-02-18", 34, "N"], ["2025-11-20", 18, "L"]
    ]);
    const windowed = await run("get_lab_results", { loinc_codes: ["2276-4"], analyte_key: null, from: "2026-01-01", to: "2026-06-30", origin: null });
    expect(windowed.rows.map((x) => x.date)).toEqual(["2026-05-12", "2026-02-18"]); // the PDF (1 Jul) is outside the window
  });

  test("get_latest_lab gives the latest per origin", async () => {
    const r = await run("get_latest_lab", { loinc_codes: ["13457-7"], analyte_key: null });
    expect(r.rows.map((x) => [x.origin, x.date, x.value_num, x.flag])).toEqual([
      ["hospital", "2026-08-25", 104, "H"],
      ["pdf", "2026-07-01", 101.5, "H"] // flag inferred by the PDF parser from the printed range
    ]);
  });

  test("list_flagged_labs", async () => {
    const r = await run("list_flagged_labs", { from: "2024-11-01", to: "2026-10-31" });
    const flagged = await main`SELECT count(*)::int AS n FROM clinical.observation o JOIN clinical.fhir_resources f ON f.id = o.fhir_resource_id
      WHERE o.source = 'valley_general' AND f.json #>> '{interpretation,0,coding,0,code}' IN ('H','L') AND o.status <> 'entered-in-error'`;
    expect(r.rows.filter((x) => x.origin === "hospital").length).toBe(flagged[0].n);
  });

  test("get_vitals and get_latest_vital split blood pressure", async () => {
    const r = await run("get_vitals", { vital: "blood_pressure", from: null, to: null });
    expect(r.rows.length).toBe(p.bp.length * 2);
    const latest = await run("get_latest_vital", { vital: "blood_pressure" });
    expect(Object.fromEntries(latest.rows.map((x) => [x.vital, x.value_num]))).toEqual({ diastolic_bp: 74, systolic_bp: 116 });
    const hr = await run("get_latest_vital", { vital: "heart_rate" });
    expect(hr.rows[0]!.value_num).toBe(p.wearable.restingHr + 8);
  });

  test("conditions: search and list by status", async () => {
    expect((await run("search_conditions", { query: "migraine" })).rows[0]).toMatchObject({ name: "Migraine without aura", onset_text: "2019-05", onset_precision: "month" });
    expect((await run("list_conditions", { status: "active" })).rows.map((r) => r.name).sort()).toEqual(["Migraine without aura", "Seasonal allergic rhinitis"]);
    expect((await run("list_conditions", { status: "resolved" })).rows.map((r) => r.name)).toEqual(["Iron deficiency anemia"]);
    expect((await run("list_conditions", { status: "all" })).rows.length).toBe(3);
  });

  test("medications: prescriptions carry their meaning; statements separate", async () => {
    const active = await run("list_prescriptions", { status: "active", from: null });
    expect(active.rows.map((r) => [r.medication, r.meaning])).toEqual([["cetirizine 10 MG Oral Tablet", "prescribed, not confirmed as taken"]]);
    expect((await run("list_prescriptions", { status: "all", from: null })).rows.length).toBe(2);
    expect((await run("search_medications", { query: "ferrous" })).rows[0]).toMatchObject({ status: "completed" });
    const statements = await run("list_medication_statements", {});
    expect(statements.rows.map((r) => [r.medication, r.not_taken]).sort()).toEqual([["cetirizine 10 MG Oral Tablet", false], ["vitamin D3 1000 UNT Oral Capsule", true]]);
  });

  test("allergies, immunizations, procedures, encounters", async () => {
    expect((await run("list_allergies", { from: null, to: null })).rows.map((r) => r.substance)).toEqual(["Penicillin"]);
    expect((await run("list_immunizations", { from: null, to: null })).rows.map((r) => r.date)).toEqual(["2025-10-02", "2024-10-11"]);
    expect((await run("list_procedures", { from: null, to: null })).rows[0]).toMatchObject({ name: "Electrocardiogram", date: p.labDates[1] });
    expect((await run("list_encounters", { from: null, to: null, class: null })).rows.length).toBe(p.labDates.length);
  });

  test("reports: list and one report with unresolved links counted", async () => {
    const reports = await run("list_reports", { from: null, to: null, category: null });
    const first = reports.rows.find((r) => r.date === p.labDates[0])!;
    expect(Number(first.linked_results) - Number(first.resolved_results)).toBe(1);
    const one = await run("get_report", { report_key: "rep:valley_general:rep-p01-0" });
    expect(one.rows[0]).toMatchObject({ report_key: "rep:valley_general:rep-p01-0" });
  });

  test("notes: full-text search and redacted excerpts", async () => {
    const hits = await run("search_notes", { query: "labs", from: null, to: null });
    expect(hits.rows.length).toBeGreaterThan(0);
    expect(hits.note).toBe("4 of 4 notes have searchable text");
    const excerpt = await run("get_note_excerpt", { document_key: "doc:valley_general:doc-p01-0", query: "plan" });
    const text = String(excerpt.rows[0]!.excerpt);
    expect(text.length).toBeLessThanOrEqual(1500);
    for (const planted of ["Marisol", "Quintrell", "1988-04-17", "VG-4471902"]) expect(text).not.toContain(planted);
    expect(text).toContain("[name]");
  });

  test("family history and other records", async () => {
    expect((await run("get_family_history", {})).rows).toEqual([expect.objectContaining({ relationship: "Mother", condition: "Type 2 diabetes mellitus", onset_age: 54 })]);
    expect((await run("get_other_records", { resource_type: null })).rows.map((r) => r.resource_type).sort()).toEqual(["CarePlan", "Goal", "ServiceRequest"]);
  });

  test("sleep nights and sessions match the generator", async () => {
    const day = truth.find((d) => d.day === "2026-10-20")!;
    const nights = await run("get_sleep_nights", { from: "2026-10-20", to: "2026-10-20", provider: "oura" });
    expect(nights.rows.length).toBe(1);
    // Ground truth keeps hours to 2 decimals (18 s).
    expect(Math.abs(Number(nights.rows[0]!.total_sleep_s) - day.sleepHours * 3600)).toBeLessThanOrEqual(18);
    const sessions = await run("get_sleep_sessions", { from: "2026-10-01", to: "2026-10-31", provider: "oura" });
    expect(sessions.rows.some((r) => r.is_main === false)).toBe(true);
    expect(nights.searched.sources[0]).toContain("Oura");
  });

  test("recovery: provider columns never mixed; Whoop marked stale", async () => {
    const oura = await run("get_recovery_daily", { from: "2026-10-01", to: "2026-10-31", provider: "oura" });
    expect(oura.rows.every((r) => r.whoop_recovery_score === null)).toBe(true);
    const whoop = await run("get_recovery_daily", { from: "2026-09-01", to: "2026-09-30", provider: "whoop" });
    expect(whoop.rows.length).toBeGreaterThan(20);
    expect(whoop.searched.sources[0]).toContain("needs reconnecting");
  });

  test("workouts", async () => {
    const r = await run("list_workouts", { from: "2026-10-01", to: "2026-10-31", provider: "oura", sport: null });
    const raw = await main`SELECT count(*)::int AS n FROM wearables.records WHERE provider = 'oura' AND data_type = 'workout' AND day BETWEEN '2026-10-01' AND '2026-10-31'`;
    expect(r.rows.length).toBe(Math.min(raw[0].n, 50));
  });

  test("metric daily and latest: Oura steps equal the generator's", async () => {
    const day = truth.find((d) => d.day === "2026-10-15")!;
    const r = await run("get_metric_daily", { metric_type: "steps", provider: "oura", from: "2026-10-15", to: "2026-10-15" });
    expect(r.rows[0]).toMatchObject({ day: "2026-10-15", n: 1, sum: day.steps });
    const latest = await run("get_metric_latest", { metric_type: "sleep_score", provider: "oura", n: null });
    expect(latest.rows.map((r) => r.day)).toEqual(["2026-10-31"]);
    // "Last 3" for a provider that stopped syncing: its own latest days.
    const whoop = await run("get_metric_latest", { metric_type: "resting_heart_rate", provider: "whoop", n: 3 });
    expect(whoop.rows.length).toBe(3);
    expect(String(whoop.rows[0]!.day) <= "2026-09-29").toBe(true);
  });

  test("samples: local times, labels, at most 31 days, downsampled", async () => {
    const r = await run("get_samples", { metric_type: "sleep_stage", provider: "oura", from: "2026-10-30", to: "2026-10-31" });
    expect(r.rows.length).toBeGreaterThan(50);
    expect(["deep", "light", "REM", "awake"]).toContain(String(r.rows[0]!.value_label));
    const dense = await run("get_samples", { metric_type: "heart_rate", provider: "oura", from: "2026-10-01", to: "2026-10-31" });
    expect(dense.rows.length).toBeLessThanOrEqual(500);
    expect(dense.truncated).toBe(true);
    await expect(runTool("get_samples", { metric_type: "heart_rate", provider: "oura", from: "2026-01-01", to: "2026-03-01" }, t)).rejects.toThrow(/31 days/);
  });

  test("search_metrics maps plain names and abbreviations to metric types", async () => {
    const rhr = await run("search_metrics", { query: "RHR" });
    const found = rhr.rows.map((r) => `${r.provider}:${r.metric_type}`);
    expect(found).toContain("oura:sleep_lowest_heart_rate");
    expect(found).toContain("whoop:resting_heart_rate");
    const steps = await run("search_metrics", { query: "steps" });
    // Synthetic Whoop cycles carry no step count, so only metrics with data are offered.
    expect(steps.rows.map((r) => `${r.provider}:${r.metric_type}`)).toContain("oura:steps");
    expect(steps.rows.every((r) => Number(r.days_with_data) > 0)).toBe(true);
  });

  test("catalog, freshness, profile, inventory", async () => {
    tested.add("get_samples");
    const metrics = await run("list_available_metrics", { provider: "whoop" });
    expect(metrics.rows.some((m) => m.metric_type === "heart_rate_variability_rmssd" && m.comparable_group === "hrv_rmssd")).toBe(true);
    const fresh = await run("get_data_freshness", {});
    expect(fresh.rows.find((r) => r.source === "whoop")).toMatchObject({ status: "needs_reconnect", stale: true });
    expect((await run("get_profile", {})).rows[0]).toMatchObject({ age_years: 38, recorded_sex: "female" });
    expect((await run("get_data_inventory", {})).rows.some((r) => r.domain === "labs" && r.source === "pdf")).toBe(true);
  });

  test("every tool has at least one test", () => {
    expect(TOOLS.map((d) => d.name).filter((n) => !tested.has(n))).toEqual([]);
  });
});
