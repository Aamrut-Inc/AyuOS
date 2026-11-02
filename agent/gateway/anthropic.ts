import Anthropic from "@anthropic-ai/sdk";
import { getSecret } from "../../shared/keychain";
import { ModelError, RetryableModelError, type Block, type ModelAdapter, type ProviderRequest, type ProviderResponse } from "./types";

// Claude through the official SDK. Key from the macOS Keychain (account
// "anthropic-api-key"; the settings screen stores it there), or
// ANTHROPIC_API_KEY for development.
//
// Notes on the current API (checked 2026-11-01):
// - temperature is rejected on every model since 2026-10-21, so the spec's
//   "temperature 0" cannot be sent; reproducibility comes from fixed prompts
//   and structured outputs instead.
// - Claude Opus 5.5 always thinks (adaptive); depth is set with effort.
// - forced tool_choice is rejected; tools run with auto + instructions.
// - server-side refusal fallbacks are opted into by default.

export function anthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || getSecret("anthropic-api-key");
}

function toWire(content: string | Block[]): any {
  if (typeof content === "string") return content;
  return content.map((b) => {
    if (b.type === "tool_result") return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error ?? false };
    return b;
  });
}

export function anthropicAdapter(apiKey = anthropicApiKey()): ModelAdapter {
  if (!apiKey) throw new ModelError("No Anthropic API key. Add one in the assistant's settings.");
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    name: "anthropic",
    async call(req: ProviderRequest): Promise<ProviderResponse> {
      const params: any = {
        model: req.model,
        max_tokens: req.maxTokens,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: req.messages.map((m) => ({ role: m.role, content: toWire(m.content) })),
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          ...(req.effort ? { effort: req.effort } : {}),
          ...(req.jsonSchema ? { format: { type: "json_schema", schema: req.jsonSchema } } : {})
        }
      };
      if (req.tools?.length) params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
      if (req.tools?.length && req.toolChoice === "none") params.tool_choice = { type: "none" };
      let response: any;
      try {
        response = await client.beta.messages.create(params, { timeout: req.timeoutMs, signal: req.signal });
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) {
          throw new RetryableModelError(error.message);
        }
        if (error instanceof Anthropic.APIError && typeof error.status === "number" && error.status >= 500) {
          throw new RetryableModelError(error.message);
        }
        throw new ModelError(error instanceof Error ? error.message : String(error));
      }
      if (response.stop_reason === "refusal") {
        throw new ModelError(`The model declined this request (${response.stop_details?.category ?? "refusal"}).`);
      }
      const content: Block[] = [];
      for (const block of response.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "tool_use") content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
      return {
        content,
        stopReason: response.stop_reason === "tool_use" ? "tool_use" : response.stop_reason === "end_turn" ? "end_turn" : response.stop_reason === "max_tokens" ? "max_tokens" : "other",
        inputTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0),
        outputTokens: response.usage?.output_tokens ?? 0,
        model: response.model ?? req.model
      };
    }
  };
}
