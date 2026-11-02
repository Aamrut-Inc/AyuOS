import { z } from "zod/v4";
import { CostCapReached, type TurnLog } from "../runtime/turn-log";
import { costUsd } from "./prices";
import { PrivacyGuard, mergeEvents, type RedactionEvent } from "./privacy";
import {
  ModelError,
  RetryableModelError,
  textOf,
  type Block,
  type Message,
  type ModelAdapter,
  type ModelChoice,
  type ProviderResponse,
  type Slot,
  type ToolSpec
} from "./types";

// Section 6: every model call goes through here. The gateway picks the model
// by slot, scans the whole outbound payload for the person's identifiers,
// asks for structured output and validates it with zod (one retry with the
// validation error), retries network/429/5xx failures with backoff, logs the
// call with tokens and cost, and stops when the per-turn cost cap is hit.

export interface CompleteOptions<T> {
  slot: Slot;
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  schema?: z.ZodType<T>;
  maxTokens: number;
  timeoutMs?: number;
  purpose: string;
}

export interface CompleteResult<T> {
  value: T;
  raw: ProviderResponse;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: number;
}

// OpenAI by default (the person's choice); both slots are settings, to be
// picked by the evaluation suite (6.2). Anthropic remains available.
export const DEFAULT_MODELS: Record<Slot, ModelChoice> = {
  fast: { provider: "openai", model: "gpt-5-mini", effort: "low" },
  strong: { provider: "openai", model: "gpt-5", effort: "medium" }
};

// Section 17: fast calls 20 s, strong calls 60 s.
const SLOT_TIMEOUT_MS: Record<Slot, number> = { fast: 20_000, strong: 60_000 };
const MAX_ATTEMPTS = 3;

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "pattern", "format", "maxItems", "minProperties", "maxProperties", "$schema", "default"
]);

// Structured outputs accept a subset of JSON Schema: closed objects and no
// numeric or length bounds. zod still enforces the bounds after the call.
export function providerSchema(schema: z.ZodType): Record<string, unknown> {
  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      if (k === "minItems" && typeof v === "number" && v > 1) continue;
      out[k] = walk(v);
    }
    if (out.type === "object" && out.properties) {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties);
    }
    return out;
  };
  return walk(z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }));
}

export function toolSpec(name: string, description: string, schema: z.ZodType): ToolSpec {
  return { name, description, input_schema: providerSchema(schema) };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(trimmed);
}

export class Gateway {
  constructor(
    private readonly adapters: (provider: string) => ModelAdapter,
    private readonly models: Record<Slot, ModelChoice>,
    private readonly guard: PrivacyGuard,
    private readonly log: TurnLog
  ) {}

  private redactPayload(system: string, messages: Message[], tools?: ToolSpec[]) {
    const events: RedactionEvent[] = [];
    const safeSystem = this.guard.redactDeep(system, events);
    const safeMessages = this.guard.redactDeep(messages, events);
    const safeTools = tools ? this.guard.redactDeep(tools, events) : undefined;
    return { system: safeSystem, messages: safeMessages, tools: safeTools, events: mergeEvents(events) };
  }

  private async callWithRetry(slot: Slot, purpose: string, request: { system: string; messages: Message[]; tools?: ToolSpec[]; jsonSchema?: Record<string, unknown>; toolChoice?: "auto" | "none"; maxTokens: number; timeoutMs: number }) {
    const choice = this.models[slot];
    const adapter = this.adapters(choice.provider);
    let lastError: unknown;
    // Section 17: past the per-turn cost cap, the lane finishes with the
    // evidence it already has.
    if (this.log.overBudget()) throw new CostCapReached(`cost cap reached before ${purpose}`);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.log.signal.aborted) throw new ModelError("cancelled");
      const started = performance.now();
      try {
        const raw = await adapter.call({ ...request, model: choice.model, effort: choice.effort, signal: this.log.signal, purpose });
        const latencyMs = Math.round(performance.now() - started);
        const cost = costUsd(raw.model, raw.inputTokens, raw.outputTokens);
        await this.log.model(`${purpose}:${choice.model}`, { system: request.system, messages: request.messages, tools: request.tools?.map((t) => t.name) }, raw.content, {
          tokensIn: raw.inputTokens, tokensOut: raw.outputTokens, costUsd: cost, latencyMs
        });
        return { raw, latencyMs, cost };
      } catch (error) {
        lastError = error;
        const latencyMs = Math.round(performance.now() - started);
        await this.log.model(`${purpose}:${choice.model}`, { purpose }, null, { tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs }, error instanceof Error ? error.message : String(error));
        if (!(error instanceof RetryableModelError) || attempt === MAX_ATTEMPTS) break;
        await Bun.sleep(500 * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof Error ? lastError : new ModelError(String(lastError));
  }

  // One model turn: raw content blocks (used by the lookup tool loop).
  async chat(options: Omit<CompleteOptions<unknown>, "schema">): Promise<CompleteResult<Block[]>> {
    const safe = this.redactPayload(options.system, options.messages, options.tools);
    await this.log.redaction(options.purpose, safe.events);
    const { raw, latencyMs, cost } = await this.callWithRetry(options.slot, options.purpose, {
      system: safe.system, messages: safe.messages, tools: safe.tools, maxTokens: options.maxTokens, timeoutMs: options.timeoutMs ?? SLOT_TIMEOUT_MS[options.slot]
    });
    return { value: raw.content, raw, usage: { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, costUsd: cost }, latencyMs };
  }

  // A structured answer validated against `schema`.
  async complete<T>(options: CompleteOptions<T> & { schema: z.ZodType<T> }): Promise<CompleteResult<T>> {
    const jsonSchema = providerSchema(options.schema);
    let messages = options.messages;
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const safe = this.redactPayload(options.system, messages, options.tools);
      await this.log.redaction(options.purpose, safe.events);
      const { raw, latencyMs, cost } = await this.callWithRetry(options.slot, options.purpose, {
        system: safe.system, messages: safe.messages, tools: safe.tools, jsonSchema,
        // A structured answer is wanted now, never another tool call.
        toolChoice: safe.tools?.length ? "none" : undefined,
        maxTokens: options.maxTokens, timeoutMs: options.timeoutMs ?? SLOT_TIMEOUT_MS[options.slot]
      });
      const text = textOf(raw.content);
      try {
        const value = options.schema.parse(parseJson(text));
        return { value, raw, usage: { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, costUsd: cost }, latencyMs };
      } catch (error) {
        lastError = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
        messages = [
          ...options.messages,
          { role: "assistant", content: text || "(empty)" },
          { role: "user", content: `That output did not match the required JSON schema:\n${lastError}\nReturn only corrected JSON.` }
        ];
      }
    }
    throw new ModelError(`${options.purpose}: output failed validation twice: ${lastError}`);
  }
}
