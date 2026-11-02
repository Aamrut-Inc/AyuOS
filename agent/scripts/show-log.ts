import { SQL } from "bun";
import { loadPostgresConfig } from "../../load/config";

// Prints the health assistant's recent questions and every step behind each
// answer (model calls, lookups, Python runs, checks), from agent.turns and
// agent.tool_runs on this Mac.
//
//   bun agent/scripts/show-log.ts                 last 5 questions, real database
//   bun agent/scripts/show-log.ts --db ayuos_eval_p01 --last 10
//   bun agent/scripts/show-log.ts --turn 100 --full   one answer, with prompts and replies

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = new URL(loadPostgresConfig().connectionString);
if (opt("db")) url.pathname = `/${opt("db")}`;
const sql = new SQL(url.toString());
const full = args.includes("--full");
const turnId = opt("turn") ? Number(opt("turn")) : null;
const last = Number(opt("last") ?? 5);

const turns = turnId
  ? await sql`SELECT * FROM agent.turns WHERE id = ${turnId} AND role = 'assistant'`
  : await sql`SELECT * FROM agent.turns WHERE role = 'assistant' AND text <> '' ORDER BY id DESC LIMIT ${last}`;

for (const t of [...turns].reverse()) {
  const [q] = await sql`SELECT text FROM agent.turns WHERE conversation_id = ${t.conversation_id} AND role = 'user' AND id < ${t.id} ORDER BY id DESC LIMIT 1`;
  const failures = (t.verifier?.code_checks ?? []).flat().map((f: any) => `${f.check}: ${f.detail}`);
  console.log(`\n━━ turn ${t.id} · ${t.created_at.toISOString()} · ${t.status} · lane ${t.lane ?? "-"} · ${((t.latency_ms ?? 0) / 1000).toFixed(1)} s · ${t.tokens ?? 0} tokens · $${Number(t.cost ?? 0).toFixed(4)}`);
  console.log(`Q: ${q?.text ?? "?"}`);
  console.log(`A: ${String(t.text).replace(/\s+/g, " ").slice(0, full ? 5000 : 300)}`);
  if (failures.length) console.log(`checks that failed: ${failures.join(" | ")}${t.verifier?.fallback ? " → fallback answer" : t.verifier?.repaired ? " → repaired" : ""}`);
  const runs = await sql`SELECT * FROM agent.tool_runs WHERE turn_id = ${t.id} ORDER BY id`;
  for (const r of runs) {
    const tokens = r.tokens_in ? ` ${r.tokens_in}→${r.tokens_out} tok` : "";
    const ms = r.latency_ms !== null ? ` ${r.latency_ms} ms` : "";
    console.log(`  ${r.created_at.toISOString().slice(11, 19)}  ${r.kind.padEnd(9)} ${r.name.padEnd(34)} ${r.status}${ms}${tokens}${r.evidence_id ? `  [${r.evidence_id.split("-")[1]}]` : ""}${r.error ? `  ERROR: ${r.error.slice(0, 200)}` : ""}`);
    if (full && r.kind === "model") {
      console.log(`      prompt: ${JSON.stringify(r.input).slice(0, 3000)}`);
      console.log(`      reply:  ${JSON.stringify(r.output).slice(0, 3000)}`);
    }
    if (full && (r.kind === "tool" || r.kind === "sql")) console.log(`      input: ${JSON.stringify(r.input)}  output: ${JSON.stringify(r.output).slice(0, 600)}`);
  }
}
await sql.close();
