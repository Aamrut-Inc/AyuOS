import { z } from "zod/v4";
import type { TurnContext } from "../../context/types";
import { toolSpec, type Gateway } from "../../gateway/index";
import type { Block, Message, ToolUseBlock } from "../../gateway/types";
import { dataBlock, render } from "../../prompts/index";
import { promptVars } from "../../router/index";
import { LookupOutput, type LookupResult } from "../../schemas";
import { runTool, toolSpecs, type ToolContext } from "../../tools/index";

// Section 9.3: one fast model with typed tools, at most 4 rounds, independent
// calls in parallel. The model finishes by calling submit_answer (forced tool
// choice isn't available on current models, so if it never does, one more
// call asks for the same output as structured JSON).

const MAX_ROUNDS = 4;
// Tool results placed in a prompt are capped (6.4); the full rows stay in
// the evidence log on the Mac.
const MAX_ROWS_IN_PROMPT = 200;

export interface LookupLaneResult extends LookupResult {
  evidence_ids: string[];
}

function toolResultText(name: string, result: Awaited<ReturnType<typeof runTool>>): string {
  const rows = result.rows.slice(0, MAX_ROWS_IN_PROMPT);
  return dataBlock(`tool:${name}`, { rows, row_count: result.rows.length, truncated: result.truncated, summary: result.summary, searched: result.searched, note: result.note }, { evidence_id: result.evidence_id });
}

export async function lookupLane(gateway: Gateway, ctx: TurnContext, message: string, tools: ToolContext): Promise<LookupLaneResult> {
  const system = render("lookup", { ...promptVars(ctx), message });
  const specs = [...toolSpecs(), toolSpec("submit_answer", "Submit the final answer: points with evidence ids, what wasn't found, and whether computation is needed.", LookupOutput as z.ZodType)];
  const messages: Message[] = [{ role: "user", content: message }];
  const evidence: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { value: content } = await gateway.chat({ slot: "fast", system, messages, tools: specs, maxTokens: 4000, purpose: `lookup:round${round}` });
    const calls = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const submit = calls.find((c) => c.name === "submit_answer");
    if (submit) {
      const parsed = LookupOutput.safeParse(submit.input);
      if (parsed.success) return { ...parsed.data, evidence_ids: evidence };
    }
    if (calls.length === 0) break;
    messages.push({ role: "assistant", content });
    tools.log.status(round === 1 ? "Looking up your records..." : "Checking a few more records...");
    const results: Block[] = await Promise.all(
      calls.map(async (call): Promise<Block> => {
        if (call.name === "submit_answer") {
          return { type: "tool_result", tool_use_id: call.id, content: "submit_answer input did not match the schema; fix it and call again.", is_error: true };
        }
        try {
          const result = await runTool(call.name, call.input, tools);
          evidence.push(result.evidence_id);
          return { type: "tool_result", tool_use_id: call.id, content: toolResultText(call.name, result) };
        } catch (error) {
          return { type: "tool_result", tool_use_id: call.id, content: `Error: ${error instanceof Error ? error.message : String(error)}`, is_error: true };
        }
      })
    );
    messages.push({ role: "user", content: results });
  }

  // No submit_answer within the round limit: ask for the answer directly.
  messages.push({ role: "user", content: "Stop calling tools. Give the answer now as JSON with points, not_found and needs_analysis, using only the tool results above." });
  const { value } = await gateway.complete({ slot: "fast", system, messages, tools: specs, schema: LookupOutput, maxTokens: 3000, purpose: "lookup:final" });
  return { ...value, evidence_ids: evidence };
}
