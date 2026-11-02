import { astVisitor, parse, type Statement } from "pgsql-ast-parser";

// Section 10.5: model-written SQL and Python are checked in code before
// anything runs. The read-only role and the view grants enforce the same
// limits again inside Postgres; this layer gives the coder a precise error
// to fix instead of a permission failure.

export const ANALYSIS_VIEWS = new Set([
  "v_lab_results", "v_vitals", "v_conditions", "v_prescriptions", "v_medication_statements", "v_allergies", "v_immunizations",
  "v_procedures", "v_encounters", "v_reports", "v_documents", "v_family_history", "v_profile", "v_sleep_nights", "v_sleep_sessions",
  "v_recovery_daily", "v_workouts", "v_wearable_daily", "v_readings", "v_metric_catalog", "v_data_freshness"
]);

const DENIED_FUNCTIONS = [
  /^pg_sleep/, /^dblink/, /^lo_/, /^pg_read/, /^pg_ls_/, /^pg_stat_file$/, /^pg_file/, /^set_config$/, /^pg_terminate_backend$/,
  /^pg_cancel_backend$/, /^pg_reload_conf$/, /^pg_rotate/, /^pg_switch/, /^pg_create/, /^pg_drop/, /^pg_advisory/, /^pg_try_advisory/,
  /_to_xml/, /^nextval$/, /^setval$/, /^pg_notify$/, /^pg_logical/, /^pg_replication/, /^txid_/, /^pg_import/, /^pg_promote$/
];

export const ROW_LIMIT = 200_000;
const READINGS_MAX_DAYS = 31;

export interface SqlCheck {
  ok: boolean;
  error?: string;
  views: string[];
}

function readingsWindowOk(sql: string): string | null {
  const text = sql.replace(/\s+/g, " ");
  if (!/\bmetric_type\s*=\s*'[^']+'/i.test(text)) return "v_readings queries must filter metric_type with = '<metric>'";
  const between = /\b(?:\w+\.)?ts\s+between\s+'([^']+)'(?:::\w+)?\s+and\s+'([^']+)'/i.exec(text);
  let from: string | undefined;
  let to: string | undefined;
  if (between) {
    from = between[1];
    to = between[2];
  } else {
    from = /\b(?:\w+\.)?ts\s*>=?\s*'([^']+)'/i.exec(text)?.[1];
    to = /\b(?:\w+\.)?ts\s*<=?\s*'([^']+)'/i.exec(text)?.[1];
  }
  if (!from || !to) return "v_readings queries must bound ts with literal dates on both sides (ts >= '...' AND ts < '...')";
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return "v_readings ts bounds are not valid dates";
  if (days > READINGS_MAX_DAYS + 1) return `v_readings ts range is ${Math.round(days)} days; at most ${READINGS_MAX_DAYS} are allowed (use v_wearable_daily for longer periods)`;
  return null;
}

export function validateSql(raw: string): SqlCheck {
  const sql = raw.trim().replace(/;\s*$/, "");
  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch (error) {
    return { ok: false, views: [], error: `SQL could not be parsed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}` };
  }
  if (statements.length !== 1) return { ok: false, views: [], error: "exactly one SQL statement is allowed" };
  const statement = statements[0]!;
  if (!["select", "with", "union", "union all", "values", "with recursive"].includes(statement.type)) {
    return { ok: false, views: [], error: `only SELECT or WITH statements are allowed, not ${statement.type}` };
  }

  const cteNames = new Set<string>();
  const views = new Set<string>();
  const problems: string[] = [];
  const visitor = astVisitor((map) => ({
    with: (w) => {
      for (const bind of w.bind) cteNames.add(bind.alias.name.toLowerCase());
      map.super().with(w);
    },
    insert: () => {
      problems.push("INSERT is not allowed");
    },
    update: () => {
      problems.push("UPDATE is not allowed");
    },
    delete: () => {
      problems.push("DELETE is not allowed");
    },
    tableRef: (t) => {
      const name = t.name.toLowerCase();
      const schema = t.schema?.toLowerCase();
      if (!schema && cteNames.has(name)) return;
      if ((schema === "agent" || !schema) && ANALYSIS_VIEWS.has(name)) {
        views.add(name);
        return;
      }
      problems.push(`${schema ? `${schema}.` : ""}${name} is not an agent view you may query (use agent.v_* views only)`);
    },
    call: (c) => {
      const name = c.function.name.toLowerCase();
      const schema = c.function.schema?.toLowerCase();
      if (schema && schema !== "pg_catalog" && schema !== "agent") problems.push(`function ${schema}.${name} is not allowed`);
      if (DENIED_FUNCTIONS.some((re) => re.test(name))) problems.push(`function ${name} is not allowed`);
      map.super().call(c);
    }
  }));
  // CTE names must be known before table refs are checked: visit twice.
  visitor.statement(statement);
  problems.length = 0;
  views.clear();
  visitor.statement(statement);

  if (problems.length) return { ok: false, views: [...views], error: [...new Set(problems)].join("; ") };
  if (views.has("v_readings")) {
    const problem = readingsWindowOk(sql);
    if (problem) return { ok: false, views: [...views], error: problem };
  }
  return { ok: true, views: [...views] };
}

// The executor wraps each query so rows come back as JSON with Postgres's
// own date and time formatting, capped at ROW_LIMIT (+1 to detect overflow).
export function wrapForExecution(sql: string): string {
  const inner = sql.trim().replace(/;\s*$/, "");
  return `SELECT coalesce(json_agg(q), '[]'::json) AS rows FROM (SELECT * FROM (\n${inner}\n) q0 LIMIT ${ROW_LIMIT + 1}) q`;
}

const BLOCKED_IMPORTS = /^\s*(?:import|from)\s+(os|sys|subprocess|socket|js|pyodide|shutil|pathlib|importlib|ctypes|urllib|http|requests|multiprocessing|threading|asyncio|builtins|io|pickle|marshal)\b/m;

export function validatePython(code: string): { ok: boolean; error?: string } {
  const blocked = BLOCKED_IMPORTS.exec(code);
  if (blocked) return { ok: false, error: `import of '${blocked[1]}' is not allowed` };
  if (/\bpyodide\.http\b/.test(code)) return { ok: false, error: "pyodide.http is not allowed" };
  if (!/\bresult\s*=/.test(code)) return { ok: false, error: "the code must set `result` to a dict" };
  return { ok: true };
}
