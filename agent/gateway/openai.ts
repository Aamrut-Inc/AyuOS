import { getSecret } from "../../shared/keychain";
import { ModelError, RetryableModelError, type Block, type Message, type ModelAdapter, type ProviderRequest, type ProviderResponse } from "./types";

// OpenAI through its Chat Completions HTTP API. Key from the macOS Keychain
// (account "openai-api-key", saved from the assistant's settings screen), or
// OPENAI_API_KEY for development. Structured outputs use strict JSON schema;
// tools are strict functions. Only these calls leave the Mac: the database
// and every tool run locally.

const BASE_URL = process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";

export function openaiApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || getSecret("openai-api-key");
}

function toWire(system: string, messages: Message[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("");
      const calls = m.content.filter((b) => b.type === "tool_use") as Array<Extract<Block, { type: "tool_use" }>>;
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {})
      });
    } else {
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content });
        else if (b.type === "text") out.push({ role: "user", content: b.text });
      }
    }
  }
  return out;
}

// OpenAI's reasoning models take reasoning_effort; others reject it.
const REASONING = /^(gpt-5|o\d)/;
// The fast slot (routing, lookups) needs little reasoning: "minimal" cut
// call latency the most. A model that rejects a value is retried without it.
const EFFORT: Record<string, string> = { low: "minimal", medium: "medium", high: "high", xhigh: "high", max: "high" };

export function openaiAdapter(apiKey = openaiApiKey()): ModelAdapter {
  if (!apiKey) throw new ModelError("No OpenAI API key. Add one in the assistant's settings.");
  const noEffort = new Set<string>();
  return {
    name: "openai",
    async call(req: ProviderRequest): Promise<ProviderResponse> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toWire(req.system, req.messages),
        max_completion_tokens: req.maxTokens
      };
      if (req.effort && REASONING.test(req.model) && !noEffort.has(req.model)) body.reasoning_effort = EFFORT[req.effort] ?? "medium";
      if (req.tools?.length) {
        body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema, strict: true } }));
        if (req.toolChoice) body.tool_choice = req.toolChoice;
      }
      if (req.jsonSchema) {
        body.response_format = { type: "json_schema", json_schema: { name: req.purpose.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "output", schema: req.jsonSchema, strict: true } };
      }

      let response: Response;
      try {
        response = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]) : AbortSignal.timeout(req.timeoutMs)
        });
      } catch (error) {
        if (req.signal?.aborted) throw new ModelError("cancelled");
        throw new RetryableModelError(`OpenAI request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const text = await response.text();
      if (!response.ok) {
        // A model without reasoning support: remember it and retry without.
        if (response.status === 400 && body.reasoning_effort && /reasoning|effort/i.test(text)) {
          noEffort.add(req.model);
          return this.call(req);
        }
        const message = `OpenAI ${response.status}: ${text.slice(0, 400)}`;
        if (response.status === 429 || response.status >= 500) throw new RetryableModelError(message);
        if (response.status === 401) throw new ModelError("The OpenAI API key was rejected. Check it in the assistant's settings.");
        throw new ModelError(message);
      }
      const json = JSON.parse(text);
      const choice = json.choices?.[0];
      const msg = choice?.message ?? {};
      if (msg.refusal) throw new ModelError(`The model declined this request: ${String(msg.refusal).slice(0, 200)}`);
      const content: Block[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const call of msg.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function?.arguments ?? "{}");
        } catch {
          input = { _unparseable: call.function?.arguments };
        }
        content.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
      }
      const finish = choice?.finish_reason;
      return {
        content,
        stopReason: finish === "tool_calls" ? "tool_use" : finish === "stop" ? "end_turn" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "other",
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        model: json.model ?? req.model
      };
    }
  };
}

export async function listOpenAiModels(apiKey = openaiApiKey()): Promise<string[]> {
  if (!apiKey) return [];
  const response = await fetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const json = await response.json();
  return (json.data ?? []).map((m: any) => String(m.id)).filter((id: string) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding)/.test(id)).sort();
}
