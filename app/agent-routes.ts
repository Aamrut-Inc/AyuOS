import { agentRuntime, type TurnEvent } from "../agent/index";
import { getSetting, setSetting } from "../agent/db";
import { listOpenAiModels, openaiApiKey } from "../agent/gateway/openai";
import { anthropicApiKey } from "../agent/gateway/anthropic";
import { DEFAULT_MODELS } from "../agent/gateway/index";
import { deleteAllFacts, deleteFact, listFacts } from "../agent/memory/facts";
import { insertExample, metricsOf, resultShape, schemaVersion } from "../agent/memory/examples";
import { isValidTimeZone, systemTimeZone } from "../agent/context/timezone";
import { setSecret } from "../shared/keychain";
import { agentPage } from "./agent-page";

// The health assistant's endpoints (spec section 3), served by the app on
// 127.0.0.1 behind the same Host/Origin checks as every other page.

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function runtimeOrError() {
  try {
    return { rt: await agentRuntime(), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /agent\.|schema "agent"|ayuos_agent/.test(message)
      ? "The assistant's database tables aren't set up yet. Run the AyuOS installer again (or `bun run migrate`), then restart the app."
      : `The assistant couldn't start: ${message}`;
    return { rt: null, error: hint };
  }
}

// POST /api/agent/turn: streams status lines, then the answer (or a
// clarifying question, or an error) as Server-Sent Events.
async function turn(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { conversation_id?: string; message?: string };
  const message = String(body.message ?? "").trim();
  if (!message) return json({ error: "Type a question first." }, 400);
  if (message.length > 4000) return json({ error: "That message is too long (4,000 characters at most)." }, 400);
  const { rt, error } = await runtimeOrError();
  if (!rt) return json({ error }, 503);

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: TurnEvent) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The page went away; the turn still finishes and is stored.
        }
      };
      // Keeps the connection open through long analyses (Bun closes idle
      // connections after 30 s).
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {}
      }, 10_000);
      rt.handleTurn({ conversation_id: body.conversation_id ?? null, message }, send)
        .catch((e) => send({ type: "error", message: /busy/.test(String(e)) ? "A question is still being answered in this conversation." : "Something went wrong." }))
        .finally(() => {
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {}
        });
    },
    cancel() {
      clearInterval(heartbeat);
    }
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

async function settings(req: Request): Promise<Response> {
  const { rt, error } = await runtimeOrError();
  if (!rt) return json({ error }, 503);
  const main = rt.db.main;
  if (req.method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as Record<string, any>;
    if (typeof body.openai_api_key === "string" && body.openai_api_key.trim()) {
      const key = body.openai_api_key.trim();
      if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) return json({ error: "That doesn't look like an OpenAI API key (it starts with sk-)." }, 400);
      setSecret("openai-api-key", key);
      rt.resetAdapters();
    }
    if (body.models && typeof body.models === "object") {
      const current = await rt.models();
      const next: any = { ...current };
      for (const slot of ["fast", "strong"] as const) {
        const m = body.models[slot];
        if (m?.model) next[slot] = { provider: m.provider === "anthropic" ? "anthropic" : "openai", model: String(m.model).slice(0, 80), effort: ["low", "medium", "high"].includes(m.effort) ? m.effort : current[slot].effort };
      }
      await setSetting(main, "models", next, "user");
      rt.resetAdapters();
    }
    if ("timezone" in body) {
      if (body.timezone === null || body.timezone === "") await setSetting(main, "timezone", systemTimeZone(), "system");
      else if (isValidTimeZone(String(body.timezone))) await setSetting(main, "timezone", String(body.timezone), "user");
      else return json({ error: "Unknown time zone." }, 400);
    }
    if (body.cost_cap_usd !== undefined) {
      const cap = Number(body.cost_cap_usd);
      if (!(cap > 0 && cap <= 20)) return json({ error: "The cost limit must be between $0.01 and $20." }, 400);
      await setSetting(main, "cost_cap_usd", cap, "user");
    }
  }
  const [tz] = await main`SELECT value #>> '{}' AS zone, source FROM agent.user_settings WHERE key = 'timezone'`;
  const openaiKey = openaiApiKey();
  return json({
    models: await rt.models(),
    defaults: DEFAULT_MODELS,
    keys: { openai: openaiKey ? `…${openaiKey.slice(-4)}` : null, anthropic: anthropicApiKey() ? "set" : null },
    timezone: { value: tz?.zone ?? systemTimeZone(), source: tz?.source ?? "system", system: systemTimeZone() },
    cost_cap_usd: await getSetting(main, "cost_cap_usd", 0.5)
  });
}

async function feedback(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { turn_id?: number; rating?: string; comment?: string };
  if (!body.turn_id || !["up", "down"].includes(String(body.rating))) return json({ error: "turn_id and rating (up/down) are required" }, 400);
  const { rt, error } = await runtimeOrError();
  if (!rt) return json({ error }, 503);
  const { rw, main } = rt.db;
  await rw`INSERT INTO agent.feedback (turn_id, rating, comment) VALUES (${body.turn_id}, ${body.rating}, ${body.comment?.slice(0, 2000) ?? null})`;
  // A thumbs up on a verified analysis answer adds its program to the
  // example library (13.2): parameters only, never results.
  if (body.rating === "up") {
    const [t] = await rw`
      SELECT a.lane, a.route, a.plan, a.evidence, a.verifier, (SELECT u.text FROM agent.turns u WHERE u.conversation_id = a.conversation_id AND u.id < a.id AND u.role = 'user' ORDER BY u.id DESC LIMIT 1) AS question
      FROM agent.turns a WHERE a.id = ${body.turn_id} AND a.role = 'assistant'`;
    const calc = t?.evidence?.calculation;
    const verified = t?.verifier && !t.verifier.fallback && (t.verifier.code_checks?.at(-1) ?? []).length === 0;
    if (t && t.lane === "analysis" && verified && calc?.code && calc.status === "ok" && t.plan) {
      await insertExample(rw, {
        question: t.question, route: t.route ?? {}, plan: t.plan, program: calc.code, result_shape: resultShape(null),
        verified_by: "user_feedback", schema_version: await schemaVersion(main), domains: t.route?.domains ?? [], metrics: metricsOf(t.plan)
      }).catch(() => {});
    }
  }
  return json({ ok: true });
}

export async function handleAgentRequest(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/agent" && req.method === "GET") return new Response(agentPage(), { headers: { "content-type": "text/html" } });
  if (!path.startsWith("/api/agent/")) return null;

  if (path === "/api/agent/turn" && req.method === "POST") return turn(req);
  if (path === "/api/agent/settings" && (req.method === "GET" || req.method === "PUT")) return settings(req);
  if (path === "/api/agent/feedback" && req.method === "POST") return feedback(req);

  const { rt, error } = await runtimeOrError();
  if (!rt) return json({ error }, 503);
  const { rw } = rt.db;

  if (path === "/api/agent/cancel" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { conversation_id?: string };
    return json({ cancelled: body.conversation_id ? rt.cancel(body.conversation_id) : false });
  }
  if (path === "/api/agent/models" && req.method === "GET") {
    try {
      return json({ models: await listOpenAiModels() });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }
  if (path === "/api/agent/conversations" && req.method === "GET") {
    const rows = await rw`
      SELECT c.id, c.title, c.started_at, max(t.created_at) AS last_at, count(t.id)::int AS turns
      FROM agent.conversations c LEFT JOIN agent.turns t ON t.conversation_id = c.id
      GROUP BY c.id ORDER BY max(t.created_at) DESC NULLS LAST LIMIT 100`;
    return json({ conversations: rows });
  }
  const conv = path.match(/^\/api\/agent\/conversations\/([\w-]+)$/);
  if (conv) {
    if (req.method === "DELETE") {
      // Deleting a conversation deletes its turns and their logs (16.2).
      await rw`DELETE FROM agent.conversations WHERE id = ${conv[1]}`;
      return json({ ok: true });
    }
    const turns = await rw`
      SELECT id::int AS id, role, text, lane, status, evidence -> 'citations' AS citations, evidence -> 'calculation' AS calculation, created_at
      FROM agent.turns WHERE conversation_id = ${conv[1]} AND text <> '' ORDER BY id`;
    return json({ turns });
  }
  if (path === "/api/agent/memory") {
    if (req.method === "DELETE") return json({ deleted: await deleteAllFacts(rw) });
    return json({ facts: await listFacts(rw) });
  }
  const fact = path.match(/^\/api\/agent\/memory\/(\d+)$/);
  if (fact && req.method === "DELETE") return json({ deleted: await deleteFact(rw, Number(fact[1])) });
  return json({ error: "Not found" }, 404);
}
