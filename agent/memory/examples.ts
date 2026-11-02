import type { SQL } from "bun";
import type { Plan, Program, Route } from "../schemas";
import { bm25 } from "./bm25";

// Section 13.2: verified analysis examples. Only programs whose answer
// passed the verifier and was confirmed (thumbs up, an evaluation pass, or
// the hand-written seed set) are stored; parameters, never results.

export interface ExampleForPrompt {
  id: number;
  question: string;
  plan: unknown;
  program: unknown;
}

export interface ExampleRow {
  question: string;
  route: Partial<Route>;
  plan: Plan | Record<string, unknown>;
  program: Program;
  result_shape: Record<string, string>;
  verified_by: "seed" | "eval" | "user_feedback";
  schema_version: string;
  domains: string[];
  metrics: string[];
}

// A hash of the agent view definitions: examples written against other
// definitions are re-tested before use.
export async function schemaVersion(sql: SQL): Promise<string> {
  const [{ defs }] = await sql`
    SELECT string_agg(c.relname || ':' || pg_get_viewdef(c.oid), '|' ORDER BY c.relname) AS defs
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'agent' AND c.relkind IN ('v', 'm') AND c.relname LIKE 'v\\_%'
  `;
  const hash = new Bun.CryptoHasher("sha256").update(String(defs ?? "")).digest("hex");
  return hash.slice(0, 16);
}

export function resultShape(result: unknown): Record<string, string> {
  if (!result || typeof result !== "object") return {};
  return Object.fromEntries(Object.entries(result as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? "array" : v === null ? "null" : typeof v]));
}

export function metricsOf(plan: unknown): string[] {
  const data = (plan as Plan | null)?.data ?? [];
  return [...new Set(data.map((d) => d.metric_type).filter((m): m is string => Boolean(m)))];
}

export async function insertExample(rw: SQL, row: ExampleRow): Promise<void> {
  await rw`
    INSERT INTO agent.example_library (question, route, plan, program, result_shape, verified_by, schema_version, domains, metrics)
    VALUES (${row.question}, ${JSON.stringify(row.route)}::text::jsonb, ${JSON.stringify(row.plan)}::text::jsonb,
            ${JSON.stringify(row.program)}::text::jsonb, ${JSON.stringify(row.result_shape)}::text::jsonb, ${row.verified_by},
            ${row.schema_version}, ${`{${row.domains.map((d) => `"${d}"`).join(",")}}`}::text[], ${`{${row.metrics.map((m) => `"${m}"`).join(",")}}`}::text[])
    ON CONFLICT (question, verified_by) DO UPDATE SET
      route = EXCLUDED.route, plan = EXCLUDED.plan, program = EXCLUDED.program, result_shape = EXCLUDED.result_shape,
      schema_version = EXCLUDED.schema_version, domains = EXCLUDED.domains, metrics = EXCLUDED.metrics
  `;
}

let currentVersion: string | null = null;
export function setCurrentSchemaVersion(v: string): void {
  currentVersion = v;
}

// Top 3 by BM25 similarity of the question plus overlap of domains and metrics.
export async function retrieveExamples(rw: SQL, question: string, route: Route | null, limit = 3): Promise<ExampleForPrompt[]> {
  const rows = (await rw`
    SELECT id::int AS id, question, plan, program, domains, metrics, schema_version FROM agent.example_library
    ORDER BY last_used_at DESC NULLS LAST, id DESC LIMIT 1000
  `) as any[];
  const usable = rows.filter((r) => !currentVersion || r.schema_version === currentVersion);
  if (!usable.length) return [];
  const domains = new Set(route?.domains ?? []);
  const scored = bm25(question, usable, (r) => r.question).map(({ doc, score }) => ({
    doc,
    score: score + 0.5 * (doc.domains ?? []).filter((d: string) => domains.has(d as any)).length
  }));
  const top = scored.sort((a, b) => b.score - a.score).filter((s) => s.score > 0).slice(0, limit).map((s) => s.doc);
  if (top.length) {
    await rw`UPDATE agent.example_library SET uses = uses + 1, last_used_at = now() WHERE id = ANY(${`{${top.map((t) => t.id).join(",")}}`}::bigint[])`.catch(() => {});
  }
  return top.map((r) => ({ id: r.id, question: r.question, plan: r.plan, program: r.program }));
}
