import type { SQL } from "bun";
import { z } from "zod/v4";
import { addDays } from "../../context/timezone";
import type { TurnContext } from "../../context/types";
import type { Gateway } from "../../gateway/index";
import type { PrivacyGuard } from "../../gateway/privacy";
import { dataBlock, render } from "../../prompts/index";
import { promptVars } from "../../router/index";
import type { TurnLog } from "../../runtime/turn-log";
import { ClarifyOutput, InterpretationOutput, type Interpretation, type Route } from "../../schemas";
import { runTool, type ToolContext, type ToolResult } from "../../tools/index";
import { analysisLane, type AnalysisResult } from "../analysis/index";
import { gatherSources, type SourcePassage } from "./sources";

// Section 11: the person's own evidence first, vetted sources second, then
// a ranked list of possible explanations with evidence for and against each,
// never a single diagnosis.

const MAX_CLARIFYING_QUESTIONS = 2;
// A question that depends on a computed pattern runs the analysis lane.
const PATTERN_WORDS = /\b(drop|dropping|dropped|rising|rose|increas|decreas|declin|trend|going (up|down)|higher|lower|worse|better|changed|lately|recently|since|over the (last|past)|pattern|keeps?|always|often|every night|more|less)\w*/i;
const WEARABLE_DOMAINS = new Set(["sleep", "recovery", "activity", "workouts", "heart", "body"]);

export interface InterpretationDeps {
  gateway: Gateway;
  log: TurnLog;
  ro: SQL;
  rw: SQL;
  guard: PrivacyGuard;
  ctx: TurnContext;
  allowedDomains: string[];
}

export interface PendingInterpretation {
  question: string;
  asked: string[];
  route: Route;
}

export type InterpretationLaneResult =
  | { kind: "clarify"; questions: string[]; pending: PendingInterpretation }
  | {
      kind: "done";
      interpretation: Interpretation;
      analysis: AnalysisResult | null;
      sources: SourcePassage[];
      evidence_ids: string[];
    };

const SearchTerms = z.object({ queries: z.array(z.string()).max(3) });

async function gatherEvidence(t: ToolContext, route: Route): Promise<ToolResult[]> {
  const today = t.ctx.today;
  const twoYears = addDays(today, -730);
  const month = addDays(today, -29);
  const calls: Array<[string, unknown]> = [
    ["list_conditions", { status: "active" }],
    ["list_prescriptions", { status: "active", from: null }],
    ["list_medication_statements", {}],
    ["list_allergies", { from: null, to: null }],
    ["list_flagged_labs", { from: twoYears, to: today }],
    ["get_vitals", { vital: "blood_pressure", from: twoYears, to: today }],
    ["get_data_freshness", {}]
  ];
  const domains = new Set(route.domains);
  const providers = route.providers.length ? route.providers : (["oura", "whoop"] as const);
  if (domains.has("sleep")) for (const p of providers.filter((x) => x !== "apple_health")) calls.push(["get_sleep_nights", { from: month, to: today, provider: p }]);
  if (domains.has("recovery") || domains.has("heart")) for (const p of providers.filter((x) => x !== "apple_health")) calls.push(["get_recovery_daily", { from: month, to: today, provider: p }]);
  if (domains.has("activity")) for (const p of providers.filter((x) => x !== "apple_health")) calls.push(["get_metric_daily", { metric_type: "steps", provider: p, from: month, to: today }]);
  if (domains.has("workouts")) calls.push(["list_workouts", { from: month, to: today, provider: null, sport: null }]);
  if (domains.has("body")) calls.push(["get_vitals", { vital: "body_weight", from: twoYears, to: today }]);
  const results = await Promise.all(calls.map(([name, input]) => runTool(name, input, t).catch(() => null)));
  return results.filter((r): r is ToolResult => r !== null);
}

function summarise(results: ToolResult[], analysis: AnalysisResult | null): string {
  const lines = results.map((r) => `${r.evidence_id}: ${r.rows.length} rows from ${r.searched.views.join(", ")}${r.rows.length === 0 ? " (none)" : ""}`);
  if (analysis) lines.push(`analysis: ${analysis.status}`);
  return lines.join("\n");
}

export async function interpretationLane(
  deps: InterpretationDeps,
  message: string,
  route: Route,
  resume: { pending: PendingInterpretation; answers: string } | null
): Promise<InterpretationLaneResult> {
  const question = resume?.pending.question ?? message;
  const tools: ToolContext = { ro: deps.ro, log: deps.log, ctx: deps.ctx, guard: deps.guard };
  deps.log.status("Gathering your records...");
  const results = await gatherEvidence(tools, route);

  let analysis: AnalysisResult | null = null;
  if (route.domains.some((d) => WEARABLE_DOMAINS.has(d)) && PATTERN_WORDS.test(question)) {
    analysis = await analysisLane({ gateway: deps.gateway, log: deps.log, ro: deps.ro, rw: deps.rw, guard: deps.guard, ctx: deps.ctx }, question, route).catch((error) => {
      deps.log.status("The supporting analysis didn't complete; continuing with the records.");
      return { status: "failed", plan: null, result: null, evidence_ids: [], code: null, coverage: { n: null, coverage_pct: null, rows: {} }, caveats: [String(error)], attempts: 0, learned: [], examples_used: [] } as AnalysisResult;
    });
  }

  // Symptom questions only, at most 2 per task, never about what the data shows.
  const asked = resume?.pending.asked ?? [];
  if (!resume && asked.length < MAX_CLARIFYING_QUESTIONS) {
    const { value } = await deps.gateway.complete({
      slot: "fast",
      system: render("clarify", { ...promptVars(deps.ctx), message: question, evidence_summary: summarise(results, analysis), already_asked: asked }),
      messages: [{ role: "user", content: question }],
      schema: ClarifyOutput,
      maxTokens: 800,
      purpose: "clarify"
    });
    const questions = value.questions.slice(0, MAX_CLARIFYING_QUESTIONS - asked.length);
    if (questions.length) return { kind: "clarify", questions, pending: { question, asked: [...asked, ...questions], route } };
  }

  deps.log.status("Looking up medical sources...");
  const { value: terms } = await deps.gateway.complete({
    slot: "fast",
    system: `${render("preamble", promptVars(deps.ctx))}\nWrite up to 3 short search phrases (2-5 words, plain medical terms, no personal details) for consumer health encyclopedia pages that would explain the findings in this question. Return JSON {queries}.\n${dataBlock("evidence_summary", summarise(results, analysis))}`,
    messages: [{ role: "user", content: question }],
    schema: SearchTerms,
    maxTokens: 400,
    purpose: "search_terms"
  });
  const sources = await gatherSources(terms.queries, deps.allowedDomains, deps.log);

  deps.log.status("Weighing possible explanations...");
  const evidence = results.map((r) => ({ evidence_id: r.evidence_id, tool: r.searched.views.join(","), rows: r.rows.slice(0, 40), searched: r.searched }));
  const { value: interpretation } = await deps.gateway.complete({
    slot: "strong",
    system: render("interpreter", {
      ...promptVars(deps.ctx),
      message: question,
      profile: deps.ctx.profile,
      evidence,
      analysis_result: analysis ? { status: analysis.status, plan: analysis.plan?.restated_question, window: analysis.plan?.time_window, result: analysis.result, caveats: analysis.caveats, evidence_ids: analysis.evidence_ids } : "not run",
      source_passages: sources.map((s) => ({ url: s.url, title: s.title, passages: s.passages.map((p) => deps.guard.redact(p).text) })),
      clarification_answers: resume ? { questions: resume.pending.asked, answers: resume.answers } : "none"
    }),
    messages: [{ role: "user", content: question }],
    schema: InterpretationOutput,
    maxTokens: 8000,
    purpose: "interpreter"
  });
  return {
    kind: "done",
    interpretation,
    analysis,
    sources,
    evidence_ids: [...results.map((r) => r.evidence_id), ...(analysis?.evidence_ids ?? []), ...sources.map((s) => s.evidence_id)]
  };
}
