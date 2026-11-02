import type { SQL } from "bun";
import type { Gateway } from "../gateway/index";
import type { PrivacyGuard } from "../gateway/privacy";
import { render } from "../prompts/index";
import { MemoryOutput } from "../schemas";
import { tokenize } from "./bm25";

// Section 13.1: durable facts the person told the agent. At most 3 per
// answered turn, never identifiers, symptom facts expire after 30 days, near
// duplicates update the existing fact. The person can list and delete them.

const SYMPTOM_TTL_DAYS = 30;
const DUPLICATE_SIMILARITY = 0.6;

function similarity(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((t) => y.has(t)).length;
  return shared / Math.min(x.size, y.size);
}

export async function rememberFacts(
  gateway: Gateway,
  rw: SQL,
  guard: PrivacyGuard,
  turn: { turnId: number; userMessage: string; finalAnswer: string; vars: Record<string, unknown> }
): Promise<number> {
  const existing = (await rw`SELECT id::int AS id, fact_text, category FROM agent.memory_facts WHERE active`) as Array<{ id: number; fact_text: string; category: string }>;
  const { value } = await gateway.complete({
    slot: "fast",
    system: render("memory", {
      ...turn.vars,
      user_message: turn.userMessage,
      final_answer: turn.finalAnswer.slice(0, 2000),
      existing_facts: existing.map((f) => f.fact_text)
    }),
    messages: [{ role: "user", content: "Extract the facts." }],
    schema: MemoryOutput,
    maxTokens: 1000,
    purpose: "memory"
  });
  let saved = 0;
  for (const fact of value.facts) {
    // Never store identifiers, even if the model returned one.
    if (guard.find(fact.fact_text).length) continue;
    if (/\[(name|birth date|id|phone|email|address)\]/.test(fact.fact_text)) continue;
    const expires = fact.category === "symptom_history" ? new Date(Date.now() + SYMPTOM_TTL_DAYS * 86400000).toISOString() : null;
    const duplicate = existing.find((e) => similarity(e.fact_text, fact.fact_text) >= DUPLICATE_SIMILARITY);
    if (duplicate) {
      await rw`UPDATE agent.memory_facts SET fact_text = ${fact.fact_text}, category = ${fact.category}, source_turn_id = ${turn.turnId},
                 expires_at = ${expires}, created_at = now() WHERE id = ${duplicate.id}`;
    } else {
      await rw`INSERT INTO agent.memory_facts (fact_text, category, source_turn_id, expires_at) VALUES (${fact.fact_text}, ${fact.category}, ${turn.turnId}, ${expires})`;
    }
    saved += 1;
  }
  return saved;
}

export async function listFacts(rw: SQL) {
  return (await rw`
    SELECT id::int AS id, fact_text, category, created_at::text AS created_at, last_used_at::text AS last_used_at, expires_at::text AS expires_at
    FROM agent.memory_facts WHERE active AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC
  `) as unknown[];
}

// Deleting a fact removes it everywhere: the row itself, so it can't be
// retrieved into any later prompt.
export async function deleteFact(rw: SQL, id: number): Promise<boolean> {
  const rows = await rw`DELETE FROM agent.memory_facts WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function deleteAllFacts(rw: SQL): Promise<number> {
  const rows = await rw`DELETE FROM agent.memory_facts RETURNING id`;
  return rows.length;
}
