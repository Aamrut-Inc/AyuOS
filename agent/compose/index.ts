import type { TurnContext } from "../context/types";
import { formatDay } from "../context/time-phrases";
import type { Gateway } from "../gateway/index";
import type { PrivacyGuard } from "../gateway/privacy";
import { render } from "../prompts/index";
import { promptVars } from "../router/index";
import { CRITICAL_RESULT_NOTICE } from "../router/red_flags";
import type { Evidence, TurnLog } from "../runtime/turn-log";
import { ComposerOutput, VerifierOutput, type Composed, type Interpretation } from "../schemas";
import { runCodeChecks, type CheckFailure, type LaneKind } from "./checks";

// Section 12: every answer is written by the composer, then checked by code
// (and for analysis and interpretation by a second model). A failing answer
// gets one repair pass, then falls back to only the facts that passed.

const LENGTH: Record<LaneKind, number> = { lookup: 120, meta: 120, analysis: 250, interpretation: 400, out_of_scope: 150 };
const ROWS_PER_EVIDENCE = 60;

export interface ComposeInput {
  lane: LaneKind;
  laneOutput: unknown;
  evidence: Evidence[];
  ctx: TurnContext;
  question: string;
  interpretation?: Interpretation | null;
  allowedDomains: string[];
  identifierRequested?: boolean;
  extraNotices?: string[];
}

export interface ComposeResult {
  answer: string;
  composed: Composed;
  verifier: {
    code_checks: CheckFailure[][];
    model_check: unknown[];
    repaired: boolean;
    fallback: boolean;
  };
  status: "answered" | "failed";
}

function evidenceIndex(evidence: Evidence[]) {
  return evidence.map((e) => ({
    evidence_id: e.id,
    tool: e.name,
    input: e.input,
    searched: e.searched,
    rows: Array.isArray(e.output) ? (e.output as unknown[]).slice(0, ROWS_PER_EVIDENCE) : e.output,
    row_count: Array.isArray(e.output) ? e.output.length : undefined
  }));
}

function freshnessRules(ctx: TurnContext): string {
  const hospitals = ctx.freshness.filter((f) => f.kind === "hospital" && !f.sandbox && f.last_sync_at);
  const stale = ctx.freshness.filter((f) => f.stale);
  return [
    hospitals.length ? `hospital data needs "as of" its import date (${hospitals.map((h) => `${h.display_name}: ${formatDay(h.last_sync_at!.slice(0, 10))}`).join(", ")})` : "hospital data needs \"as of\" its import date",
    stale.length ? `these providers need "as of" their last data date: ${stale.map((s) => `${s.display_name} (${s.status === "needs_reconnect" ? "needs reconnecting, " : ""}last data ${s.last_data_at ? formatDay(s.last_data_at.slice(0, 10)) : "none"})`).join(", ")}` : null
  ].filter(Boolean).join("; ");
}

function notices(input: ComposeInput): string[] {
  const out = [...(input.extraNotices ?? [])];
  const critical = input.evidence.some((e) => Array.isArray(e.output) && (e.output as any[]).some((r) => r?.critical === true));
  if (critical) out.unshift(CRITICAL_RESULT_NOTICE);
  return out;
}

async function draft(gateway: Gateway, input: ComposeInput, repair: { failures: string[]; previous: Composed } | null): Promise<Composed> {
  const slot = input.lane === "lookup" || input.lane === "meta" ? "fast" : "strong";
  const vars = {
    ...promptVars(input.ctx),
    message: input.question,
    freshness_rules: freshnessRules(input.ctx),
    length_limit: LENGTH[input.lane],
    interpretation: input.lane === "interpretation",
    out_of_scope: input.lane === "out_of_scope",
    out_of_scope_reason: (input.laneOutput as any)?.out_of_scope_reason ?? "",
    lane_output: input.laneOutput,
    evidence_index: evidenceIndex(input.evidence),
    time_zone_and_ranges: `Time zone ${input.ctx.timezone}; today ${input.ctx.today}; ranges ${JSON.stringify(input.ctx.time_ranges.map((r) => ({ id: r.id, label: r.label })))}.`,
    notices: notices(input).join(" "),
    repair: Boolean(repair),
    verifier_failures: repair?.failures.join("\n"),
    previous_draft: repair?.previous.answer_markdown
  };
  const { value } = await gateway.complete({
    slot,
    system: render("composer", vars),
    messages: [{ role: "user", content: input.question }],
    schema: ComposerOutput,
    maxTokens: 6000,
    purpose: repair ? "composer:repair" : "composer"
  });
  return value;
}

async function modelCheck(gateway: Gateway, input: ComposeInput, composed: Composed) {
  const { value } = await gateway.complete({
    slot: "fast",
    system: render("verifier", {
      ...promptVars(input.ctx),
      message: input.question,
      evidence: evidenceIndex(input.evidence),
      answer_markdown: composed.answer_markdown
    }),
    messages: [{ role: "user", content: "Check the draft." }],
    schema: VerifierOutput,
    maxTokens: 2000,
    purpose: "verifier"
  });
  return value;
}

// Only the claims that pass the code checks on their own.
function fallbackAnswer(input: ComposeInput, composed: Composed, guard: PrivacyGuard): string {
  const passing = composed.claims.filter((claim) => {
    const one: Composed = { ...composed, answer_markdown: claim.text, claims: [claim] };
    return claim.evidence_ids.length > 0 && runCodeChecks({ ...input, composed: one, guard }).filter((f) => f.check !== "freshness" && f.check !== "safety").length === 0;
  });
  const lines = passing.map((c) => `- ${c.text}`);
  const out = [
    ...notices(input),
    lines.length ? `Here is what I could verify from your data:\n\n${lines.join("\n")}` : "I couldn't verify an answer from your data.",
    "I couldn't produce a fully checked answer to the rest of your question."
  ];
  const sources = composed.citations.web.filter((w) => input.allowedDomains.some((d) => w.url.includes(d)));
  if (sources.length) out.push(`Sources: ${sources.map((s) => `[${s.title}](${s.url})`).join(", ")}`);
  if (input.lane === "interpretation") out.push("Please discuss this with your clinician.");
  return out.join("\n\n");
}

export async function composeAndVerify(gateway: Gateway, log: TurnLog, guard: PrivacyGuard, input: ComposeInput): Promise<ComposeResult> {
  log.status("Writing the answer...");
  const record: ComposeResult["verifier"] = { code_checks: [], model_check: [], repaired: false, fallback: false };
  let composed = await draft(gateway, input, null);

  for (let pass = 1; pass <= 2; pass++) {
    const failures = runCodeChecks({ ...input, composed, guard });
    record.code_checks.push(failures);
    let modelFailures: string[] = [];
    // Model check for analysis and interpretation answers (12.3), only once
    // the code checks pass, to save a call on drafts that will be repaired.
    if (failures.length === 0 && (input.lane === "analysis" || input.lane === "interpretation")) {
      log.status("Checking the answer...");
      try {
        const verdict = await modelCheck(gateway, input, composed);
        record.model_check.push(verdict);
        if (!verdict.pass) modelFailures = verdict.failures.map((f) => `${f.check}: ${f.reason}`).concat(verdict.fix_notes ? [verdict.fix_notes] : []);
      } catch (error) {
        record.model_check.push({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (failures.length === 0 && modelFailures.length === 0) {
      await log.safety("verifier", { passed: true, pass });
      return { answer: composed.answer_markdown, composed, verifier: record, status: "answered" };
    }
    if (pass === 2) break;
    record.repaired = true;
    log.status("Fixing a problem in the answer...");
    try {
      composed = await draft(gateway, input, { failures: [...failures.map((f) => `${f.check}: ${f.detail}`), ...modelFailures], previous: composed });
    } catch {
      break;
    }
  }
  record.fallback = true;
  await log.safety("verifier", { passed: false, fallback: true });
  return { answer: fallbackAnswer(input, composed, guard), composed, verifier: record, status: "answered" };
}

export function sourcesFor(evidence: Evidence[], composed: Composed) {
  const used = new Set(composed.claims.flatMap((c) => c.evidence_ids));
  return {
    data: evidence
      .filter((e) => used.has(e.id) || composed.citations.data.some((d) => d.evidence_id === e.id))
      .map((e) => ({
        evidence_id: e.id,
        tool: e.name,
        searched: e.searched,
        rows: Array.isArray(e.output) ? e.output.length : null
      })),
    web: composed.citations.web
  };
}

