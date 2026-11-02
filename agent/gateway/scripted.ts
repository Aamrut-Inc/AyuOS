import type { ModelAdapter, ProviderRequest, ProviderResponse, Block } from "./types";

// A deterministic stand-in for a provider, for tests and for running the
// pipeline without network access. Each handler sees the request and returns
// content; the request log lets tests assert what would have left the Mac.

export type ScriptHandler = (request: ProviderRequest) => Block[] | string | Promise<Block[] | string>;

export function scriptedAdapter(handler: ScriptHandler, requests: ProviderRequest[] = []): ModelAdapter & { requests: ProviderRequest[] } {
  return {
    name: "scripted",
    requests,
    async call(request: ProviderRequest): Promise<ProviderResponse> {
      requests.push(request);
      const result = await handler(request);
      const content: Block[] = typeof result === "string" ? [{ type: "text", text: result }] : result;
      return {
        content,
        stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        inputTokens: JSON.stringify(request.messages).length / 4,
        outputTokens: JSON.stringify(content).length / 4,
        model: request.model
      };
    }
  };
}
