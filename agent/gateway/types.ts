// Provider-neutral shapes for model calls (section 6). Adapters translate
// these to and from each provider's wire format.

export type Slot = "fast" | "strong";

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type Block = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: string | Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ModelChoice {
  provider: string; // "anthropic" | "scripted"
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ProviderRequest {
  model: string;
  effort?: ModelChoice["effort"];
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  jsonSchema?: Record<string, unknown>;
  // "none": tools stay defined (the history contains tool calls) but the
  // model must answer in text/JSON now.
  toolChoice?: "auto" | "none";
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  purpose: string;
}

export interface ProviderResponse {
  content: Block[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface ModelAdapter {
  name: string;
  call(request: ProviderRequest): Promise<ProviderResponse>;
}

// Network, 429 and 5xx failures: retried with backoff.
export class RetryableModelError extends Error {}
// Anything else (bad request, auth, refusal): fails the step.
export class ModelError extends Error {}

export function textOf(content: Block[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
