import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { AgentRuntime, type TurnEvent } from "../../index";
import { scriptedAdapter } from "../../gateway/scripted";
import type { Block, ProviderRequest } from "../../gateway/types";
import { ensureEvalDb, evalUrl } from "./helpers";
import { EVAL_NOW } from "../synth/build";

// The turn pipeline end to end on the p01 synthetic database, with a
// scripted model standing in for the provider: routing, tools and evidence
// ids, the composer and its code checks, logging, the privacy guard, the
// red-flag and identifier paths (which must not call a model at all).

let main: SQL;
let rt: AgentRuntime;
const requests: ProviderRequest[] = [];

function lastUser(req: ProviderRequest): string {
  const m = req.messages.at(-1)!;
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

function evidenceIdsIn(req: ProviderRequest, tool: string): string[] {
  const all = JSON.stringify(req.messages);
  return [...all.matchAll(new RegExp(`tool:${tool}\\\\?" evidence_id=\\\\?"(e\\d+)`, "g"))].map((m) => m[1]!);
}

// A tiny scripted "model" good enough to drive the lookup path.
function script(req: ProviderRequest): Block[] | string {
  if (req.purpose === "router") {
    const q = lastUser(req).toLowerCase();
    const lane = /ldl|cholesterol/.test(q) ? "lookup" : /sync|connected/.test(q) ? "meta" : /stop my/.test(q) ? "out_of_scope" : "lookup";
    return JSON.stringify({ urgent: false, urgent_reason: null, lane, domains: lane === "meta" ? ["data_status"] : ["labs"], providers: [], time_range_ids: [], follows_up: false, changes: [], clarifying_question: null, out_of_scope_reason: lane === "out_of_scope" ? "medication change" : null, confidence: 0.9 });
  }
  if (req.purpose.startsWith("lookup:round")) {
    const round = Number(req.purpose.slice(-1));
    if (round === 1) return [{ type: "tool_use", id: "t1", name: "search_lab_tests", input: { query: "LDL" } }];
    if (round === 2) return [{ type: "tool_use", id: "t2", name: "get_latest_lab", input: { loinc_codes: ["13457-7"], analyte_key: null } }];
    const [latest] = evidenceIdsIn(req, "get_latest_lab");
    return [{ type: "tool_use", id: "t3", name: "submit_answer", input: { points: [{ text: "Latest LDL cholesterol (calculated): 104 mg/dL on 2026-08-25 from Valley General, flagged H (range 0-99).", evidence_ids: [latest] }], not_found: [], needs_analysis: false } }];
  }
  if (req.purpose.startsWith("composer")) {
    const system = req.system;
    const id = /"evidence_id":"(e\d+)","tool":"get_latest_lab"/.exec(system)?.[1] ?? "e2";
    if (/data_status|v_data_freshness|get_data_freshness/.test(system) && !/get_latest_lab/.test(system)) {
      const fid = /"evidence_id":"(e\d+)","tool":"get_data_freshness"/.exec(system)?.[1] ?? "e1";
      return JSON.stringify({ answer_markdown: "Oura is connected and active. Whoop needs reconnecting.", claims: [{ text: "Oura active; Whoop needs reconnecting", evidence_ids: [fid], numbers: [], metric_type: null, provider_or_source: null }], citations: { data: [{ view: "v_data_freshness", source: "all", date_range: null, evidence_id: fid }], web: [] }, follow_up_suggestions: [] });
    }
    return JSON.stringify({
      answer_markdown: "Your latest LDL cholesterol was **104 mg/dL** on 25 Aug 2026, just above the lab's range of 0-99 mg/dL (flagged high). This is your Valley General result, as of the import on 15 Oct 2026.",
      claims: [{ text: "LDL 104 mg/dL on 25 Aug 2026, range 0-99", evidence_ids: [id], numbers: [104, 0, 99], metric_type: null, provider_or_source: "valley_general" }],
      citations: { data: [{ view: "v_lab_results", source: "valley_general", date_range: "2026-08-25", evidence_id: id }], web: [] },
      follow_up_suggestions: []
    });
  }
  if (req.purpose === "memory") return JSON.stringify({ facts: [] });
  throw new Error(`unscripted purpose ${req.purpose}`);
}

beforeAll(async () => {
  main = await ensureEvalDb("p01");
  rt = await AgentRuntime.open({
    config: { connectionString: evalUrl("p01") },
    adapter: () => scriptedAdapter(script, requests),
    now: () => EVAL_NOW,
    recordMacZone: false,
    memory: false
  });
}, 300_000);

afterAll(async () => {
  await rt?.close();
  await main?.close();
});

describe("turn pipeline (scripted model)", () => {
  test("a lookup question runs tools, cites evidence and passes the code checks", async () => {
    const events: TurnEvent[] = [];
    const out = await rt.handleTurn({ message: "What was my last LDL?" }, (e) => events.push(e));
    expect(out.status).toBe("answered");
    expect(out.lane).toBe("lookup");
    expect(out.verifier?.fallback).toBe(false);
    expect(out.verifier?.code_checks[0]).toEqual([]);
    expect(out.answer).toContain("104 mg/dL");
    expect(events[0]).toEqual({ type: "status", text: "Reading your question..." });
    const answer = events.find((e) => e.type === "answer") as Extract<TurnEvent, { type: "answer" }>;
    expect((answer.citations as any).data.length).toBeGreaterThan(0);
    const runs = await main`SELECT kind, name, evidence_id FROM agent.tool_runs WHERE turn_id = ${out.turn_id} ORDER BY id`;
    expect(runs.filter((r: any) => r.kind === "tool").map((r: any) => r.name)).toEqual(["search_lab_tests", "get_latest_lab"]);
    expect(runs.filter((r: any) => r.kind === "model").length).toBe(out.model_calls);
    const [turn] = await main`SELECT status, lane, latency_ms, cost FROM agent.turns WHERE id = ${out.turn_id}`;
    expect(turn.status).toBe("answered");
  }, 60_000);

  test("the composer's mistakes are caught: an invented number fails, gets one repair, then falls back", async () => {
    let drafts = 0;
    const bad = await AgentRuntime.open({
      config: { connectionString: evalUrl("p01") },
      adapter: () => scriptedAdapter((req) => {
        if (req.purpose.startsWith("composer")) {
          drafts += 1;
          return JSON.stringify({ answer_markdown: "Your LDL was 131 mg/dL and you take atorvastatin daily.", claims: [{ text: "LDL 131", evidence_ids: ["e2"], numbers: [131], metric_type: null, provider_or_source: null }], citations: { data: [], web: [] }, follow_up_suggestions: [] });
        }
        return script(req);
      }),
      now: () => EVAL_NOW, recordMacZone: false, memory: false
    });
    const out = await bad.handleTurn({ message: "What was my last LDL?" });
    await bad.close();
    expect(drafts).toBe(2);
    expect(out.verifier?.repaired).toBe(true);
    expect(out.verifier?.fallback).toBe(true);
    const checks = out.verifier!.code_checks[0]!.map((c) => c.check);
    expect(checks).toContain("numbers");
    expect(out.answer).toContain("I couldn't produce a fully checked answer");
    expect(out.answer).not.toContain("131");
  }, 60_000);

  test("red flags answer from code, with no model call", async () => {
    const before = requests.length;
    const out = await rt.handleTurn({ message: "I have crushing chest pain spreading to my left arm right now" });
    expect(out.status).toBe("urgent");
    expect(out.answer).toContain("emergency services");
    expect(requests.length).toBe(before);
    const self = await rt.handleTurn({ message: "I don't want to be alive anymore" });
    expect(self.answer).toContain("crisis line");
    expect(self.answer).not.toMatch(/\d{3}/); // no phone numbers
  });

  test("identifier questions are answered locally and never sent to a model", async () => {
    const before = requests.length;
    const out = await rt.handleTurn({ message: "What's my MRN at Valley General?" });
    expect(out.answer).toContain("VG-4471902");
    expect(requests.length).toBe(before);
  });

  test("identifiers in a message are redacted before leaving the Mac", async () => {
    const before = requests.length;
    await rt.handleTurn({ message: "My name is Marisol Quintrell, born 1988-04-17, email marisol.quintrell@example.org. What was my last LDL?" });
    const outbound = JSON.stringify(requests.slice(before));
    for (const planted of ["Marisol", "Quintrell", "1988-04-17", "marisol.quintrell@example.org", "VG-4471902"]) expect(outbound).not.toContain(planted);
    expect(outbound).toContain("[name]");
    const [redactions] = await main`SELECT count(*)::int AS n FROM agent.tool_runs WHERE kind = 'redaction'`;
    expect(redactions.n).toBeGreaterThan(0);
    const logged = await main`SELECT input::text AS i FROM agent.tool_runs WHERE kind = 'redaction' LIMIT 5`;
    for (const r of logged) expect(r.i).not.toContain("Quintrell");
  }, 60_000);

  test("meta questions use freshness and inventory", async () => {
    const out = await rt.handleTurn({ message: "When did my devices last sync and what's connected?" });
    expect(out.lane).toBe("meta");
    expect(out.status).toBe("answered");
    expect(out.model_calls).toBeLessThanOrEqual(2);
  }, 60_000);

  test("one active turn per conversation; conversations and turns are stored", async () => {
    const first = await rt.handleTurn({ message: "What was my last LDL?" });
    const convs = await main`SELECT count(*)::int AS n FROM agent.turns WHERE conversation_id = ${first.conversation_id}`;
    expect(convs[0].n).toBe(2);
  }, 60_000);
});
