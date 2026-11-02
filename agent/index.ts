import { loadPostgresConfig, type PostgresConfig } from "../load/config";
import { composeAndVerify, sourcesFor, type ComposeResult } from "./compose/index";
import { ALLOWED_DOMAINS_DEFAULT, type LaneKind } from "./compose/checks";
import { buildTurnContext } from "./context/builder";
import type { TurnContext } from "./context/types";
import { getSetting, openAgentDb, setSetting, type AgentDb } from "./db";
import { anthropicAdapter } from "./gateway/anthropic";
import { openaiAdapter } from "./gateway/openai";
import { setPriceOverrides } from "./gateway/prices";
import { DEFAULT_MODELS, Gateway } from "./gateway/index";
import { loadIdentifiers, PrivacyGuard } from "./gateway/privacy";
import { ModelError, type ModelAdapter, type ModelChoice, type Slot } from "./gateway/types";
import { analysisLane, type AnalysisResult } from "./lanes/analysis/index";
import { interpretationLane, type PendingInterpretation } from "./lanes/interpretation/index";
import { lookupLane } from "./lanes/lookup/index";
import { schemaVersion, setCurrentSchemaVersion } from "./memory/examples";
import { rememberFacts } from "./memory/facts";
import { render } from "./prompts/index";
import { answerIdentifierQuestion, isIdentifierQuestion, promptVars, route as routeMessage } from "./router/index";
import { checkRedFlags, urgentMessage } from "./router/red_flags";
import { CostCapReached, TurnLog } from "./runtime/turn-log";
import { SummaryOutput, type Route } from "./schemas";
import { runTool, type ToolContext } from "./tools/index";

// handleTurn(): the single entry point (section 2). One turn:
//   1 context builder -> 2 red flags in code -> 3 router -> 4 lane ->
//   5 composer + checks (+ model check, repair, fallback) -> 6 answer,
//   then logging and memory.

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "clarify"; text: string; turn_id: number; conversation_id: string }
  | { type: "answer"; text: string; turn_id: number; conversation_id: string; lane: string; citations: unknown; evidence_ids: string[]; calculation: unknown | null }
  | { type: "error"; message: string; turn_id?: number; conversation_id?: string };

export interface TurnRequest {
  conversation_id?: string | null;
  message: string;
}

export interface TurnOutcome {
  conversation_id: string;
  turn_id: number;
  status: "answered" | "clarifying" | "declined" | "failed" | "cancelled" | "urgent";
  lane: string | null;
  answer: string;
  route: Route | null;
  verifier: ComposeResult["verifier"] | null;
  latency_ms: number;
  cost_usd: number;
  tokens: number;
  model_calls: number;
  background: Promise<unknown>;
}

// Section 17: hard limits per lane. The spec's starting values (10/20/90/180 s)
// assumed ~1-2 s model calls; OpenAI's GPT-5 models took 4-10 s per call in
// practice, so a 4-call lookup needed ~25 s. Overridable with the setting
// `lane_time_limits_ms`.
const LANE_LIMIT_MS: Record<string, number> = { meta: 30_000, lookup: 60_000, analysis: 180_000, interpretation: 300_000, out_of_scope: 60_000 };
const HISTORY_WINDOW = 12; // last 6 exchanges verbatim

export interface RuntimeOptions {
  config?: PostgresConfig;
  adapter?: (provider: string) => ModelAdapter;
  now?: () => Date;
  recordMacZone?: boolean;
  // Off in evaluation runs, so stored facts don't leak between questions.
  memory?: boolean;
}

export class AgentRuntime {
  private readonly active = new Map<string, AbortController>();
  private adapterCache = new Map<string, ModelAdapter>();

  private constructor(
    readonly db: AgentDb,
    public guard: PrivacyGuard,
    private readonly options: RuntimeOptions
  ) {}

  static async open(options: RuntimeOptions = {}): Promise<AgentRuntime> {
    const db = await openAgentDb(options.config ?? loadPostgresConfig());
    const guard = new PrivacyGuard(await loadIdentifiers(db.main));
    setCurrentSchemaVersion(await schemaVersion(db.main));
    return new AgentRuntime(db, guard, options);
  }

  async reloadIdentifiers(): Promise<void> {
    this.guard = new PrivacyGuard(await loadIdentifiers(this.db.main));
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  adapter(provider: string): ModelAdapter {
    if (this.options.adapter) return this.options.adapter(provider);
    let adapter = this.adapterCache.get(provider);
    if (!adapter) {
      if (provider === "openai") adapter = openaiAdapter();
      else if (provider === "anthropic") adapter = anthropicAdapter();
      else throw new ModelError(`No adapter for provider "${provider}"`);
      this.adapterCache.set(provider, adapter);
    }
    return adapter;
  }

  resetAdapters(): void {
    this.adapterCache.clear();
  }

  async models(): Promise<Record<Slot, ModelChoice>> {
    const stored = await getSetting<Partial<Record<Slot, ModelChoice>>>(this.db.main, "models", {});
    return { fast: { ...DEFAULT_MODELS.fast, ...stored.fast }, strong: { ...DEFAULT_MODELS.strong, ...stored.strong } };
  }

  async allowedDomains(): Promise<string[]> {
    return getSetting<string[]>(this.db.main, "allowed_source_domains", ALLOWED_DOMAINS_DEFAULT);
  }

  cancel(conversationId: string): boolean {
    const controller = this.active.get(conversationId);
    if (!controller) return false;
    controller.abort();
    // Running SQL of the read role (a single-user app: these are this turn's).
    void this.db.main`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE usename = 'ayuos_agent_ro' AND state = 'active' AND pid <> pg_backend_pid()`.catch(() => {});
    return true;
  }

  async handleTurn(request: TurnRequest, emit: (event: TurnEvent) => void = () => {}): Promise<TurnOutcome> {
    const started = performance.now();
    const { rw, ro, main } = this.db;
    const message = request.message.trim();
    if (!message) throw new Error("empty message");

    let conversationId = request.conversation_id ?? null;
    if (conversationId) {
      const [exists] = await rw`SELECT 1 AS ok FROM agent.conversations WHERE id = ${conversationId}`;
      if (!exists) conversationId = null;
    }
    if (!conversationId) {
      const [conv] = await rw`INSERT INTO agent.conversations (title) VALUES (${message.slice(0, 80)}) RETURNING id`;
      conversationId = conv.id as string;
    }
    if (this.active.has(conversationId)) {
      emit({ type: "error", message: "A question is still being answered in this conversation." });
      throw new Error("conversation busy");
    }
    const controller = new AbortController();
    this.active.set(conversationId, controller);

    // The pending clarification (if any) is read before this message is stored.
    const [pendingRow] = await rw`
      SELECT id::int AS id, pending, route FROM agent.turns
      WHERE conversation_id = ${conversationId} AND role = 'assistant' ORDER BY id DESC LIMIT 1
    `;
    const pending = pendingRow?.pending ?? null;

    await rw`INSERT INTO agent.turns (conversation_id, role, text) VALUES (${conversationId}, 'user', ${message})`;
    const [assistant] = await rw`INSERT INTO agent.turns (conversation_id, role, text) VALUES (${conversationId}, 'assistant', '') RETURNING id::int AS id`;
    const turnId = assistant.id as number;
    const costCap = Number(await getSetting(main, "cost_cap_usd", 0.5));
    const tokenCap = Number(await getSetting(main, "token_cap_per_turn", 400_000));
    setPriceOverrides(await getSetting(main, "model_prices", {}));
    const log = new TurnLog(rw, turnId, costCap, controller.signal, (text) => emit({ type: "status", text }), tokenCap);
    log.status("Reading your question...");

    const finish = async (outcome: Omit<TurnOutcome, "conversation_id" | "turn_id" | "latency_ms" | "cost_usd" | "tokens" | "model_calls" | "background"> & {
      plan?: unknown; evidence?: unknown; pending?: unknown; background?: Promise<unknown>;
    }): Promise<TurnOutcome> => {
      const latency = Math.round(performance.now() - started);
      await rw`
        UPDATE agent.turns SET text = ${outcome.answer}, lane = ${outcome.lane}, route = ${JSON.stringify(outcome.route ?? null)}::text::jsonb,
          plan = ${JSON.stringify(outcome.plan ?? null)}::text::jsonb, evidence = ${JSON.stringify(outcome.evidence ?? null)}::text::jsonb,
          verifier = ${JSON.stringify(outcome.verifier ?? null)}::text::jsonb, pending = ${JSON.stringify(outcome.pending ?? null)}::text::jsonb,
          status = ${outcome.status}, latency_ms = ${latency}, tokens = ${Math.round(log.tokens)}, cost = ${log.costUsd}
        WHERE id = ${turnId}
      `;
      this.active.delete(conversationId!);
      return {
        ...outcome,
        conversation_id: conversationId!,
        turn_id: turnId,
        latency_ms: latency,
        cost_usd: log.costUsd,
        tokens: log.tokens,
        model_calls: log.modelCalls,
        background: outcome.background ?? Promise.resolve()
      };
    };

    try {
      // 2. Red flags, in code, before any model.
      const flag = checkRedFlags(message);
      if (flag.urgent) {
        await log.safety("red_flag", { category: flag.category, source: "code" });
        const text = urgentMessage(flag.category);
        emit({ type: "answer", text, turn_id: turnId, conversation_id: conversationId, lane: "urgent", citations: { data: [], web: [] }, evidence_ids: [], calculation: null });
        return await finish({ status: "urgent", lane: "urgent", answer: text, route: null, verifier: null });
      }

      // The person's own identifiers: a local template, never sent to a model.
      if (isIdentifierQuestion(message)) {
        const text = await answerIdentifierQuestion(main, message);
        emit({ type: "answer", text, turn_id: turnId, conversation_id: conversationId, lane: "identifier", citations: { data: [], web: [] }, evidence_ids: [], calculation: null });
        return await finish({ status: "answered", lane: "identifier", answer: text, route: null, verifier: null });
      }

      // Identifiers are reloaded every turn, so a new hospital import is covered.
      this.guard = new PrivacyGuard(await loadIdentifiers(main));

      // 1. Context (after the red-flag check, which needs none).
      const ctx = await buildTurnContext({ ro, rw, main, now: this.options.now?.(), recordMacZone: this.options.recordMacZone }, conversationId, message);
      const gateway = new Gateway((p) => this.adapter(p), await this.models(), this.guard, log);
      const allowedDomains = await this.allowedDomains();
      const notices: string[] = [];
      if (ctx.zone_notice) {
        const shown = await getSetting<string | null>(main, "zone_notice_shown", null);
        if (shown !== ctx.zone_notice.slice(0, 60)) {
          notices.push(ctx.zone_notice);
          await setSetting(main, "zone_notice_shown", ctx.zone_notice.slice(0, 60), "system");
        }
      }

      // A pending clarification resumes its task with this message as the answer.
      let routed: Route;
      let resumeInterpretation: { pending: PendingInterpretation; answers: string } | null = null;
      let questionForLane = message;
      if (pending?.kind === "interpretation") {
        resumeInterpretation = { pending: pending.task as PendingInterpretation, answers: message };
        routed = pending.task.route as Route;
        questionForLane = pending.task.question;
      } else {
        const routerMessage = pending?.kind === "router" ? `${pending.question}\n(Answer to your question "${pending.asked}": ${message})` : message;
        log.status("Working out how to answer...");
        routed = await routeMessage(gateway, ctx, routerMessage);
        questionForLane = routerMessage;
      }

      if (routed.urgent) {
        await log.safety("red_flag", { reason: routed.urgent_reason, source: "router" });
        const text = urgentMessage(/self|suicid|harm/i.test(routed.urgent_reason ?? "") ? "self_harm" : null);
        emit({ type: "answer", text, turn_id: turnId, conversation_id: conversationId, lane: "urgent", citations: { data: [], web: [] }, evidence_ids: [], calculation: null });
        return await finish({ status: "urgent", lane: "urgent", answer: text, route: routed, verifier: null });
      }
      if (routed.lane === "clarify" && routed.clarifying_question) {
        const text = routed.clarifying_question;
        emit({ type: "clarify", text, turn_id: turnId, conversation_id: conversationId });
        return await finish({ status: "clarifying", lane: "clarify", answer: text, route: routed, verifier: null, pending: { kind: "router", question: questionForLane, asked: text } });
      }

      const tools: ToolContext = { ro, log, ctx, guard: this.guard };
      const deps = { gateway, log, ro, rw, guard: this.guard, ctx };
      const lane = routed.lane === "clarify" ? "interpretation" : routed.lane;
      const run = async (): Promise<TurnOutcome> => {
        let laneOutput: unknown;
        let laneKind: LaneKind = lane as LaneKind;
        let interpretation = null;
        let analysis: AnalysisResult | null = null;

        if (lane === "meta") {
          await runTool("get_data_freshness", {}, tools);
          await runTool("get_data_inventory", {}, tools);
          laneOutput = { freshness: ctx.freshness, inventory: ctx.data_inventory, note: "AyuOS keeps one person's data on this Mac; hospital records are a one-time download per login; Oura and Whoop sync every 30 minutes; Apple Health and lab PDFs are uploaded by hand." };
        } else if (lane === "lookup") {
          const result = await lookupLane(gateway, ctx, questionForLane, tools);
          if (result.needs_analysis) {
            laneKind = "analysis";
            analysis = await analysisLane(deps, questionForLane, routed);
            laneOutput = { lookup: result, analysis: analysisSummary(analysis) };
          } else laneOutput = result;
        } else if (lane === "analysis") {
          analysis = await analysisLane(deps, questionForLane, routed);
          laneOutput = analysisSummary(analysis);
        } else if (lane === "interpretation") {
          const result = await interpretationLane({ ...deps, allowedDomains }, questionForLane, routed, resumeInterpretation);
          if (result.kind === "clarify") {
            const text = `Before I look into this, ${result.questions.length > 1 ? "two quick questions" : "a quick question"} about things your data can't show:\n\n${result.questions.map((q) => `- ${q}`).join("\n")}`;
            emit({ type: "clarify", text, turn_id: turnId, conversation_id: conversationId!, });
            return finish({ status: "clarifying", lane: "interpretation", answer: text, route: routed, verifier: null, pending: { kind: "interpretation", task: result.pending } });
          }
          interpretation = result.interpretation;
          analysis = result.analysis;
          laneOutput = { interpretation: result.interpretation, analysis: analysis ? analysisSummary(analysis) : null, sources: result.sources.map((s) => ({ title: s.title, url: s.url, accessed: s.accessed, evidence_id: s.evidence_id })) };
          if (result.interpretation.urgency === "urgent") {
            await log.safety("red_flag", { source: "interpretation" });
            notices.unshift(urgentMessage(null));
          }
        } else {
          // out_of_scope: share relevant facts from the records where useful.
          const facts = routed.domains.length ? await lookupLane(gateway, ctx, questionForLane, tools).catch(() => null) : null;
          laneOutput = { out_of_scope_reason: routed.out_of_scope_reason ?? "outside what this assistant does", facts };
          laneKind = "out_of_scope";
        }

        const composed = await composeAndVerify(gateway, log, this.guard, {
          lane: laneKind,
          laneOutput,
          evidence: log.all(),
          ctx,
          question: questionForLane,
          interpretation,
          allowedDomains,
          extraNotices: notices
        });
        const calculation = analysis?.code ? { code: analysis.code, plan: analysis.plan, status: analysis.status } : null;
        const citations = sourcesFor(log.all(), composed.composed);
        emit({ type: "answer", text: composed.answer, turn_id: turnId, conversation_id: conversationId!, lane: laneKind, citations, evidence_ids: log.all().map((e) => e.id), calculation });
        const outcome = await finish({
          status: lane === "out_of_scope" ? "declined" : "answered",
          lane: laneKind,
          answer: composed.answer,
          route: routed,
          verifier: composed.verifier,
          plan: analysis?.plan ?? null,
          evidence: { ids: log.all().map((e) => e.id), summary: summaryForFollowUp(laneKind, analysis, composed.answer), citations, calculation }
        });
        outcome.background = this.afterTurn(gateway, ctx, conversationId!, turnId, message, composed.answer);
        return outcome;
      };

      const limits = { ...LANE_LIMIT_MS, ...(await getSetting<Record<string, number>>(main, "lane_time_limits_ms", {})) };
      const limit = limits[lane] ?? 60_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), limit);
      });
      const result = await Promise.race([run(), timeout]);
      clearTimeout(timer);
      if (result === "timeout") {
        controller.abort();
        const gathered = log.all().filter((e) => e.kind === "tool" || e.kind === "sql");
        const looked = [...new Set(gathered.map((e) => e.name.replace(/_/g, " ")))];
        const text = `Sorry, this took longer than the ${limit / 1000}-second limit, so I stopped before I could write and check an answer.${looked.length ? ` I had already looked at: ${looked.join(", ")}.` : ""} Please try again; if it keeps happening, a narrower question, or a faster model in Settings, helps.`;
        emit({ type: "answer", text, turn_id: turnId, conversation_id: conversationId, lane, citations: { data: [], web: [] }, evidence_ids: [], calculation: null });
        return await finish({ status: "failed", lane, answer: text, route: routed, verifier: null });
      }
      return result;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const capped = error instanceof CostCapReached;
      const text = cancelled
        ? "Stopped."
        : capped
          ? "This question reached the cost limit set for one answer before I could finish a checked answer. You can raise the limit in the assistant's settings."
          : error instanceof ModelError && /API key/.test(error.message)
            ? error.message
            : "Sorry, something went wrong while answering. The details are in the assistant's log on this Mac.";
      console.error("Agent turn failed:", error instanceof Error ? error.stack ?? error.message : error);
      await log.failure("model", "turn", { message: "turn failed" }, error instanceof Error ? error.message : String(error));
      emit({ type: "error", message: text, turn_id: turnId, conversation_id: conversationId });
      return await finish({ status: cancelled ? "cancelled" : "failed", lane: null, answer: text, route: null, verifier: null });
    } finally {
      this.active.delete(conversationId);
    }
  }

  // After the answer: memory facts and the rolling summary (7.1, 13.1).
  private async afterTurn(gateway: Gateway, ctx: TurnContext, conversationId: string, turnId: number, message: string, answer: string): Promise<void> {
    const { rw } = this.db;
    if (this.options.memory !== false) {
      await rememberFacts(gateway, rw, this.guard, { turnId, userMessage: message, finalAnswer: answer, vars: promptVars(ctx) }).catch((e) => console.warn("memory extraction failed:", e instanceof Error ? e.message : e));
    }
    const [{ n }] = await rw`SELECT count(*)::int AS n FROM agent.turns WHERE conversation_id = ${conversationId}`;
    if (n > HISTORY_WINDOW && (n - HISTORY_WINDOW) % 6 < 2) {
      const older = await rw`SELECT role, text FROM agent.turns WHERE conversation_id = ${conversationId} ORDER BY id DESC OFFSET ${HISTORY_WINDOW} LIMIT 12`;
      const [conv] = await rw`SELECT summary FROM agent.conversations WHERE id = ${conversationId}`;
      const { value } = await gateway.complete({
        slot: "fast",
        system: render("summary", { ...promptVars(ctx), previous_summary: conv?.summary ?? "none", turns: older.reverse().map((t: any) => `${t.role}: ${t.text.slice(0, 800)}`).join("\n") }),
        messages: [{ role: "user", content: "Update the summary." }],
        schema: SummaryOutput,
        maxTokens: 600,
        purpose: "history_summary"
      }).catch(() => ({ value: null }));
      if (value) await rw`UPDATE agent.conversations SET summary = ${value.summary} WHERE id = ${conversationId}`;
    }
  }
}

function analysisSummary(a: AnalysisResult) {
  return {
    status: a.status,
    restated_question: a.plan?.restated_question,
    definitions: a.plan?.definitions,
    time_window: a.plan?.time_window,
    method: a.plan?.method,
    result: a.result,
    coverage: a.coverage,
    caveats: a.caveats,
    evidence_ids: a.evidence_ids,
    learned: a.status === "failed" ? a.learned : undefined
  };
}

function summaryForFollowUp(lane: string, analysis: AnalysisResult | null, answer: string): string {
  if (analysis?.plan) return `${analysis.plan.restated_question} (${analysis.plan.time_window.label}, ${analysis.plan.method}): ${analysis.status}`;
  return `${lane}: ${answer.slice(0, 300)}`;
}

let shared: Promise<AgentRuntime> | null = null;

// The app's runtime, opened on first use.
export function agentRuntime(): Promise<AgentRuntime> {
  shared ??= AgentRuntime.open().catch((error) => {
    shared = null;
    throw error;
  });
  return shared;
}

