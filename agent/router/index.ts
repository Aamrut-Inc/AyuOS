import type { SQL } from "bun";
import type { TurnContext } from "../context/types";
import type { Gateway } from "../gateway/index";
import { render } from "../prompts/index";
import { RouterOutput, type Route } from "../schemas";

// Section 8.2-8.3: one fast call picks the cheapest lane able to answer.

const ESCALATION: Record<string, Route["lane"]> = { lookup: "analysis", analysis: "interpretation" };

export function promptVars(ctx: TurnContext): Record<string, unknown> {
  return {
    local_now: ctx.local_now,
    timezone: ctx.timezone,
    today: ctx.today,
    data_inventory: ctx.inventory_text,
    freshness: ctx.freshness_text,
    history_summary: ctx.history_summary ?? "none",
    history: ctx.history.length ? ctx.history.map((h) => `${h.role}: ${h.text.slice(0, 600)}`).join("\n") : "none",
    last_evidence: ctx.last_evidence ? { question: ctx.last_evidence.question, lane: ctx.last_evidence.lane, route: ctx.last_evidence.route, summary: ctx.last_evidence.result_summary } : "none",
    time_ranges: ctx.time_ranges.length ? ctx.time_ranges.map((r) => ({ id: r.id, phrase: r.phrase, from: r.from, to: r.to, label: r.label })) : "none",
    memory: ctx.memory.length ? ctx.memory.map((m) => m.fact_text).join("; ") : "none",
    profile: ctx.profile
  };
}

export async function route(gateway: Gateway, ctx: TurnContext, message: string): Promise<Route> {
  const { value } = await gateway.complete({
    slot: "fast",
    system: render("router", { ...promptVars(ctx), message }),
    messages: [{ role: "user", content: message }],
    schema: RouterOutput,
    maxTokens: 2000,
    purpose: "router"
  });
  // Low confidence: escalate to the more capable lane instead of asking (8.3).
  if (value.confidence < 0.6 && ESCALATION[value.lane]) return { ...value, lane: ESCALATION[value.lane]! };
  if (value.confidence < 0.6 && value.lane === "clarify" && ctx.last_evidence) return { ...value, lane: "interpretation" };
  return value;
}

// Questions about the person's own identifiers are answered by a local
// template that reads the value directly: shown in the app, never sent to a
// model (8.3).
const IDENTIFIER_QUESTION = /\b(what('?s| is| are)|tell me|show me|give me|do you have)\b.*\bmy\s+(mrn|medical record number|patient (id|number)|record number|date of birth|birth ?date|dob|birthday|home address|address|phone( number)?|e-?mail( address)?|full name|legal name|name on (file|record))\b/i;

export function isIdentifierQuestion(message: string): boolean {
  return IDENTIFIER_QUESTION.test(message);
}

export async function answerIdentifierQuestion(main: SQL, message: string): Promise<string> {
  const text = message.toLowerCase();
  const patients = await main`
    SELECT p.source, c.display_name, c.sandbox, p.family_name, p.given_names, p.birth_date::text AS birth_date, p.phone, p.email,
           concat_ws(', ', p.address_line, p.address_city, p.address_state, p.address_postal_code) AS address,
           (SELECT json_agg(json_build_object('system', i.system, 'value', i.value)) FROM clinical.patient_identifier i WHERE i.patient_id = p.id) AS ids
    FROM clinical.patient p LEFT JOIN ops.ehr_connections c ON c.slug = p.source
    ORDER BY coalesce(c.sandbox, false), p.source
  `;
  const real = patients.filter((p: any) => !p.sandbox);
  if (real.length === 0) return "I don't have that: no real hospital record with your details has been imported (only sandbox test data, if any).";
  const lines: string[] = [];
  for (const p of real) {
    const where = p.display_name ?? p.source;
    if (/mrn|record number|patient (id|number)/.test(text)) {
      const ids = (p.ids ?? []) as Array<{ system: string | null; value: string }>;
      lines.push(ids.length ? `${where}: ${ids.map((i) => i.value).join(", ")}` : `${where}: no identifier on file`);
    } else if (/birth|dob|birthday/.test(text)) {
      lines.push(`${where}: ${p.birth_date ?? "not on file"}`);
    } else if (/address/.test(text) && !/e-?mail/.test(text)) {
      lines.push(`${where}: ${p.address || "not on file"}`);
    } else if (/phone/.test(text)) {
      lines.push(`${where}: ${(p.phone ?? []).join(", ") || "not on file"}`);
    } else if (/e-?mail/.test(text)) {
      lines.push(`${where}: ${(p.email ?? []).join(", ") || "not on file"}`);
    } else {
      lines.push(`${where}: ${[...(p.given_names ?? []), p.family_name].filter(Boolean).join(" ") || "not on file"}`);
    }
  }
  return `From your hospital records (read on this Mac; this was not sent to any AI service):\n\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
