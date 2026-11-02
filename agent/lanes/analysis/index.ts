import type { SQL } from "bun";
import type { TurnContext } from "../../context/types";
import type { Gateway } from "../../gateway/index";
import type { PrivacyGuard } from "../../gateway/privacy";
import { retrieveExamples, type ExampleForPrompt } from "../../memory/examples";
import { render, template } from "../../prompts/index";
import { promptVars } from "../../router/index";
import type { TurnLog } from "../../runtime/turn-log";
import { sandbox } from "../../sandbox/index";
import { CoderOutput, ExplainerOutput, PlanOutput, type Plan, type Program, type Route } from "../../schemas";
import { ROW_LIMIT, validatePython, validateSql, wrapForExecution } from "./validator";

// Section 10: the planner decides what to compute, the coder writes SQL and
// one Python snippet, code validates and runs them (SQL as the read-only
// role, Python in the sandbox), result checks catch empty and insufficient
// data, and an error explainer drives at most 3 attempts.

export const SUFFICIENCY_DEFAULTS = {
  describe: "3 values",
  trend: "14 days with data, at least 60% of days covered",
  compare_periods: "7 days with data in each period",
  correlate: "21 paired days",
  lagged_correlate: "28 paired days",
  anomalies: "28 days of baseline before the period examined"
};

export const AYU_STATS_SIGNATURES = `- s.to_daily(df, day_col="day", value_col="value", how="mean") -> Series indexed by day
- s.align_daily({"name": series_or_df, ...}, on="day", how="inner") -> DataFrame
- s.coverage(series, start, end) -> {n, days_in_window, coverage_pct}
- s.describe(series) -> {n, mean, median, sd, min, max, q1, q3, first_day, last_day}
- s.trend(series, per="week") -> {n, slope, slope_low, slope_high, kendall_tau, p_value, change_over_window}
- s.compare_periods(a, b) -> {n, n_a, n_b, median_a, median_b, mean_a, mean_b, difference (b - a), p_value, rank_biserial}
- s.correlate(x, y, method="spearman") -> {n, coefficient, p_value}
- s.lagged_correlate(x, y, lags=range(-3, 4)) -> {n, by_lag: [{lag, n, coefficient, p_value}], strongest_lag}
- s.anomalies(series, baseline_days=28, z=2.0) -> {n, episodes: [{start, end, days, peak_z, direction}]}
- s.threshold_count(series, op, value) -> {n, count, pct, days}
- s.recovery_time(series, event_day, baseline_days=28) -> {n, baseline_median, band, recovered_on, days_to_recover}
- s.fdr(p_values) -> {n, adjusted}
A "series" may be a DataFrame with a day/local_day column and one value column, or a Series indexed by day.`;

const MAX_ATTEMPTS = 3;

export interface AnalysisDeps {
  gateway: Gateway;
  log: TurnLog;
  ro: SQL;
  rw: SQL;
  guard: PrivacyGuard;
  ctx: TurnContext;
}

export interface AnalysisResult {
  status: "ok" | "insufficient_data" | "failed";
  plan: Plan | null;
  result: Record<string, unknown> | null;
  evidence_ids: string[];
  code: Program | null;
  coverage: { n: number | null; coverage_pct: number | null; rows: Record<string, number> };
  caveats: string[];
  attempts: number;
  learned: string[];
  examples_used: number[];
}

const DOMAIN_METRICS: Record<string, RegExp> = {
  sleep: /^sleep|stage|bedtime/,
  recovery: /readiness|recovery|hrv|heart_rate_variability|resting|temperature|strain|spo2|oxygen|breathing/,
  activity: /steps|energy|activity|met|distance|sedentary|non_wear|inactivity|target/,
  workouts: /^workout|strain/,
  heart: /heart|hrv|pulse|cardio|vo2/,
  body: /weight|height|temperature/
};

async function catalogRows(ro: SQL, route: Route | null) {
  const rows = (await ro`
    SELECT metric_type, source_provider, display_name, unit_canonical, value_kind, comparable_group, day_anchor, cautions,
           first_day::text AS first_day, last_day::text AS last_day, days_with_data
    FROM agent.v_metric_catalog WHERE days_with_data > 0 ORDER BY source_provider, metric_type
  `) as any[];
  const domains = route?.domains ?? [];
  const patterns = domains.map((d) => DOMAIN_METRICS[d]).filter(Boolean) as RegExp[];
  const providers = route?.providers?.length ? new Set(route.providers) : null;
  const filtered = rows.filter((r) => (!patterns.length || patterns.some((p) => p.test(r.metric_type))) && (!providers || providers.has(r.source_provider)));
  return (filtered.length ? filtered : rows).map((r) => ({ ...r }));
}

function rowSample(rows: unknown[]): unknown[] {
  return rows.slice(0, 5);
}

function insufficiency(plan: Plan, result: Record<string, any>): string | null {
  const s = plan.sufficiency;
  const n = typeof result.n === "number" ? result.n : null;
  if (s.min_n !== null && n !== null && n < s.min_n) return `only ${n} data points (at least ${s.min_n} needed)`;
  if (s.min_days_per_group !== null) {
    for (const key of ["n_a", "n_b"]) {
      if (typeof result[key] === "number" && result[key] < s.min_days_per_group) return `only ${result[key]} days in one group (at least ${s.min_days_per_group} needed)`;
    }
    if (n !== null && !("n_a" in result) && n < s.min_days_per_group) return `only ${n} days with data (at least ${s.min_days_per_group} needed)`;
  }
  const cov = typeof result.coverage_pct === "number" ? result.coverage_pct : null;
  if (s.min_coverage_pct !== null && cov !== null && cov < s.min_coverage_pct) return `data on only ${Math.round(cov)}% of days (at least ${s.min_coverage_pct}% needed)`;
  return null;
}

function emptyOutputs(plan: Plan, result: Record<string, unknown>): string[] {
  return plan.outputs.filter((key) => key in result && (result[key] === null || (typeof result[key] === "number" && !Number.isFinite(result[key] as number))));
}

export async function plan(deps: AnalysisDeps, message: string, route: Route | null, examples: ExampleForPrompt[]): Promise<Plan> {
  const previous = route?.follows_up && deps.ctx.last_evidence?.plan ? deps.ctx.last_evidence.plan : null;
  const { value } = await deps.gateway.complete({
    slot: "strong",
    system: render("planner", {
      ...promptVars(deps.ctx),
      message,
      sufficiency_defaults: SUFFICIENCY_DEFAULTS,
      schema_context: template("schema_context"),
      catalog_rows: await catalogRows(deps.ro, route),
      verified_examples: examples.length ? examples.map((e) => ({ question: e.question, plan: e.plan })) : "none",
      previous_plan: previous,
      changes: route?.changes ?? []
    }),
    messages: [{ role: "user", content: message }],
    schema: PlanOutput,
    maxTokens: 6000,
    purpose: "planner"
  });
  return value;
}

async function code(deps: AnalysisDeps, p: Plan, examples: ExampleForPrompt[], retry: { likely_cause: string; fix_instructions: string; previous: Program } | null): Promise<Program> {
  const { value } = await deps.gateway.complete({
    slot: "strong",
    system: render("coder", {
      ...promptVars(deps.ctx),
      ayu_stats_signatures: AYU_STATS_SIGNATURES,
      schema_context: template("schema_context"),
      plan: p,
      verified_examples: examples.length ? examples.map((e) => ({ question: e.question, program: e.program })) : "none",
      retry: Boolean(retry),
      likely_cause: retry?.likely_cause,
      fix_instructions: retry?.fix_instructions,
      previous_code: retry?.previous
    }),
    messages: [{ role: "user", content: "Write the queries and Python for this plan." }],
    schema: CoderOutput,
    maxTokens: 8000,
    purpose: retry ? "coder:retry" : "coder"
  });
  return value;
}

async function explain(deps: AnalysisDeps, message: string, p: Plan, program: Program, error: string, samples: Record<string, unknown[]>) {
  const { value } = await deps.gateway.complete({
    slot: "fast",
    system: render("explainer", {
      ...promptVars(deps.ctx),
      message,
      plan: p,
      queries_and_python: program,
      error_or_empty_notice: error,
      schema_context_subset: template("schema_context"),
      sample_rows: deps.guard.redactDeep(samples)
    }),
    messages: [{ role: "user", content: "Find the most likely cause." }],
    schema: ExplainerOutput,
    maxTokens: 2000,
    purpose: "explainer"
  });
  return value;
}

interface Execution {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
  rows: Record<string, unknown[]>;
  evidence_ids: string[];
}

// Runs the validated program: each query as the read-only role (15 s limit
// set on the role), then the Python in the sandbox (20 s).
export async function execute(deps: Pick<AnalysisDeps, "ro" | "log">, program: Program, emptyIsMeaningful: boolean): Promise<Execution> {
  const rows: Record<string, unknown[]> = {};
  const evidence_ids: string[] = [];
  for (const q of program.queries) {
    const check = validateSql(q.sql);
    if (!check.ok) return { ok: false, error: `query "${q.name}" rejected: ${check.error}`, rows, evidence_ids };
  }
  const py = validatePython(program.python);
  if (!py.ok) return { ok: false, error: `Python rejected: ${py.error}`, rows, evidence_ids };

  for (const q of program.queries) {
    const started = performance.now();
    try {
      const [res] = await deps.ro.unsafe(wrapForExecution(q.sql));
      const data = ((res?.rows ?? []) as unknown[]);
      if (data.length > ROW_LIMIT) return { ok: false, error: `query "${q.name}" returned more than ${ROW_LIMIT} rows; aggregate in SQL`, rows, evidence_ids };
      rows[q.name] = data;
      evidence_ids.push(await deps.log.addEvidence("sql", q.name, { sql: q.sql }, data, { latencyMs: Math.round(performance.now() - started), provenance: [`sql:${q.name}`] }));
      if (data.length === 0 && !emptyIsMeaningful) return { ok: false, error: `query "${q.name}" returned no rows`, rows, evidence_ids };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.log.failure("sql", q.name, { sql: q.sql }, message, Math.round(performance.now() - started));
      return { ok: false, error: `query "${q.name}" failed: ${message}`, rows, evidence_ids };
    }
  }
  const run = await sandbox().run(program.python, rows);
  if (!run.ok) {
    await deps.log.failure("python", "analysis", { python: program.python }, run.error ?? "failed", run.latencyMs);
    return { ok: false, error: `Python failed: ${run.error}`, rows, evidence_ids };
  }
  evidence_ids.push(await deps.log.addEvidence("python", "analysis", { python: program.python }, run.result, { latencyMs: run.latencyMs, provenance: ["python:analysis"] }));
  return { ok: true, result: run.result, rows, evidence_ids };
}

export async function analysisLane(deps: AnalysisDeps, message: string, route: Route | null): Promise<AnalysisResult> {
  const examples = await retrieveExamples(deps.rw, message, route).catch(() => [] as ExampleForPrompt[]);
  deps.log.status("Planning the analysis...");
  const p = await plan(deps, message, route, examples);
  const out: AnalysisResult = {
    status: "failed", plan: p, result: null, evidence_ids: [], code: null, coverage: { n: null, coverage_pct: null, rows: {} },
    caveats: p.caveats, attempts: 0, learned: [], examples_used: examples.map((e) => e.id)
  };
  let retry: { likely_cause: string; fix_instructions: string; previous: Program } | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    out.attempts = attempt;
    deps.log.status(attempt === 1 ? "Running the analysis..." : `Running the analysis (attempt ${attempt} of ${MAX_ATTEMPTS})...`);
    const program = await code(deps, p, examples, retry);
    out.code = program;
    const exec = await execute(deps, program, p.empty_is_meaningful);
    out.evidence_ids.push(...exec.evidence_ids);
    out.coverage.rows = Object.fromEntries(Object.entries(exec.rows).map(([k, v]) => [k, v.length]));

    let failure = exec.ok ? null : exec.error!;
    if (exec.ok && exec.result) {
      const missing = emptyOutputs(p, exec.result);
      const short = insufficiency(p, exec.result as Record<string, any>);
      out.result = exec.result;
      out.coverage.n = typeof exec.result.n === "number" ? exec.result.n : null;
      out.coverage.coverage_pct = typeof exec.result.coverage_pct === "number" ? exec.result.coverage_pct : null;
      // Insufficient data is an answer, not an error: no retry (10.7).
      if (short) {
        out.status = "insufficient_data";
        out.caveats = [...out.caveats, `insufficient data: ${short}`];
        return out;
      }
      if (missing.length) failure = `result values ${missing.join(", ")} are NaN or missing`;
      else {
        out.status = "ok";
        return out;
      }
    }
    // Empty queries after the coder's best effort may simply mean no data
    // exists: the explainer decides whether to retry; the last attempt
    // reports what was learned.
    out.learned.push(failure!);
    if (attempt === MAX_ATTEMPTS) break;
    deps.log.status("Something didn't work; figuring out why...");
    const explained = await explain(deps, message, p, program, failure!, Object.fromEntries(Object.entries(exec.rows).map(([k, v]) => [k, rowSample(v)])));
    out.learned.push(`likely cause: ${explained.likely_cause}`);
    retry = { ...explained, previous: program };
  }
  out.status = "failed";
  return out;
}
