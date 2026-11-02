import type { SQL } from "bun";
import { onDataChanged } from "../jobs/index";
import { recordSystemZone, zoneDisagreement } from "../jobs/tz-history";
import { bm25 } from "../memory/bm25";
import { settleLastNight } from "./last-night";
import { formatDay, resolveTimePhrases } from "./time-phrases";
import { formatOffset, isValidTimeZone, localParts, systemTimeZone } from "./timezone";
import type { FreshnessRow, InventoryItem, LastEvidence, MemoryFact, TurnContext } from "./types";

// Section 7: one TurnContext per turn, assembled in plain code before any
// model call, so every step sees the same time, freshness and history.

const STALE_MS = 48 * 3600 * 1000;

export interface ContextDeps {
  ro: SQL;
  rw: SQL;
  main: SQL;
  now?: Date;
  // Off in evaluation, where each persona's zone is pinned.
  recordMacZone?: boolean;
}

let inventoryCache: { key: string; items: InventoryItem[] } | null = null;
onDataChanged(() => {
  inventoryCache = null;
});

export async function loadFreshness(ro: SQL, now: Date): Promise<FreshnessRow[]> {
  const rows = await ro`
    SELECT kind, source, display_name, status, sandbox, last_data_at::text AS last_data_at,
           last_sync_at::text AS last_sync_at, last_error, item_count
    FROM agent.v_data_freshness ORDER BY kind, source
  `;
  return rows.map((r: any) => ({
    ...r,
    stale:
      r.kind === "wearable" &&
      r.status !== "not_connected" &&
      (r.status === "needs_reconnect" || !r.last_data_at || now.getTime() - Date.parse(r.last_data_at) > STALE_MS)
  }));
}

export function freshnessText(rows: FreshnessRow[]): string {
  const parts: string[] = [];
  for (const r of rows) {
    const last = r.last_data_at ? formatDay(r.last_data_at.slice(0, 10)) : "none";
    if (r.kind === "wearable") {
      if (r.status === "not_connected" && !r.last_data_at) continue;
      parts.push(`${r.display_name}: ${r.status === "needs_reconnect" ? "needs reconnect, " : r.status === "manual_upload" ? "manual upload, " : ""}last data ${last}${r.stale && r.status !== "needs_reconnect" ? " (none in 48 h)" : ""}`);
    } else if (r.kind === "hospital") {
      parts.push(`${r.display_name}: ${r.sandbox ? "sandbox test data (hidden)" : `imported ${r.last_sync_at ? formatDay(r.last_sync_at.slice(0, 10)) : "unknown"}`}`);
    } else {
      parts.push(`lab PDFs: ${r.item_count ?? 0} confirmed results${r.status === "needs_review" ? ", some awaiting review" : ""}`);
    }
  }
  if (!rows.some((r) => r.kind === "hospital" && !r.sandbox)) parts.push("hospital data: none real (sandbox only or not connected)");
  return parts.join("; ");
}

export async function loadInventory(ro: SQL): Promise<InventoryItem[]> {
  const [{ v }] = await ro`SELECT coalesce((SELECT max(last_ts)::text FROM agent.v_wearable_daily), '') || (SELECT count(*)::text FROM agent.v_lab_results) AS v`;
  const cached = inventoryCache;
  if (cached && cached.key === v) return cached.items;
  const items = (await ro`
    SELECT 'labs' AS domain, origin AS source, count(*)::int AS count, min(effective_date)::text AS first, max(effective_date)::text AS last FROM agent.v_lab_results GROUP BY origin
    UNION ALL SELECT 'vitals', 'hospital', count(*)::int, min(effective_date)::text, max(effective_date)::text FROM agent.v_vitals HAVING count(*) > 0
    UNION ALL SELECT 'conditions', 'hospital', count(*)::int, NULL, NULL FROM agent.v_conditions HAVING count(*) > 0
    UNION ALL SELECT 'prescriptions', 'hospital', count(*)::int, min(authored_date)::text, max(authored_date)::text FROM agent.v_prescriptions HAVING count(*) > 0
    UNION ALL SELECT 'allergies', 'hospital', count(*)::int, NULL, NULL FROM agent.v_allergies HAVING count(*) > 0
    UNION ALL SELECT 'immunizations', 'hospital', count(*)::int, min(occurred_date)::text, max(occurred_date)::text FROM agent.v_immunizations HAVING count(*) > 0
    UNION ALL SELECT 'encounters', 'hospital', count(*)::int, min(start_date)::text, max(start_date)::text FROM agent.v_encounters HAVING count(*) > 0
    UNION ALL SELECT 'notes', 'hospital', count(*)::int, min(doc_date)::text, max(doc_date)::text FROM agent.v_documents HAVING count(*) > 0
    UNION ALL SELECT 'sleep', provider, count(*)::int, min(day)::text, max(day)::text FROM agent.v_sleep_nights GROUP BY provider
    UNION ALL SELECT 'recovery', provider, count(*)::int, min(day)::text, max(day)::text FROM agent.v_recovery_daily GROUP BY provider
    UNION ALL SELECT 'workouts', provider, count(*)::int, min(day)::text, max(day)::text FROM agent.v_workouts GROUP BY provider
    UNION ALL SELECT 'wearable_metrics', source_provider, count(DISTINCT metric_type)::int, min(local_day)::text, max(local_day)::text FROM agent.v_wearable_daily GROUP BY source_provider
  `) as InventoryItem[];
  const fresh = { key: v, items: items.map((i) => ({ ...i })) };
  inventoryCache = fresh;
  return fresh.items;
}

export function inventoryText(items: InventoryItem[]): string {
  if (!items.length) return "no data";
  const fmt = (d: string | null) => (d ? d.slice(0, 7) : "?");
  return items
    .map((i) => (i.domain === "wearable_metrics" ? `${i.source}: ${i.count} metrics ${fmt(i.first)} to ${fmt(i.last)}` : `${i.domain} (${i.source}): ${i.count}${i.first ? ` ${fmt(i.first)} to ${fmt(i.last)}` : ""}`))
    .join("; ");
}

export async function retrieveMemory(rw: SQL, message: string, limit = 20): Promise<MemoryFact[]> {
  const facts = (await rw`
    SELECT id::int AS id, fact_text, category, created_at FROM agent.memory_facts
    WHERE active AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 500
  `) as Array<MemoryFact & { created_at: Date }>;
  // Relevance first, then recency (13.1): facts with no word in common keep
  // their recency order after the relevant ones.
  const ranked = bm25(message, facts, (f) => f.fact_text);
  return ranked.slice(0, limit).map(({ doc }) => ({ id: doc.id, fact_text: doc.fact_text, category: doc.category }));
}

export async function buildTurnContext(deps: ContextDeps, conversationId: string | null, message: string): Promise<TurnContext> {
  const now = deps.now ?? new Date();
  if (deps.recordMacZone !== false) await recordSystemZone(deps.main);
  const [{ zone }] = await deps.ro`SELECT agent.current_tz() AS zone`;
  const timezone = isValidTimeZone(zone) ? zone : systemTimeZone();
  const parts = localParts(timezone, now);
  const today = parts.date;

  const [freshness, inventory, profileRows, memory] = await Promise.all([
    loadFreshness(deps.ro, now),
    loadInventory(deps.ro),
    deps.ro`SELECT age_years, recorded_sex, hospitals FROM agent.v_profile`,
    retrieveMemory(deps.rw, message)
  ]);
  const time_ranges = resolveTimePhrases(message, timezone, now);
  await settleLastNight(deps.ro, time_ranges, today);

  let history: TurnContext["history"] = [];
  let history_summary: string | null = null;
  let last_evidence: LastEvidence | null = null;
  if (conversationId) {
    const turns = await deps.rw`
      SELECT id::int AS id, role, text, lane, route, plan, evidence, status FROM agent.turns
      WHERE conversation_id = ${conversationId} ORDER BY id DESC LIMIT 12
    `;
    history = turns.slice(0, 12).reverse().map((t: any) => ({ role: t.role, text: t.text })).slice(-12);
    const [conv] = await deps.rw`SELECT summary FROM agent.conversations WHERE id = ${conversationId}`;
    history_summary = conv?.summary ?? null;
    const lastAnswer = turns.find((t: any) => t.role === "assistant" && t.status === "answered");
    const lastQuestion = lastAnswer ? turns.find((t: any) => t.role === "user" && t.id < lastAnswer.id) : null;
    if (lastAnswer) {
      last_evidence = {
        turn_id: lastAnswer.id,
        question: lastQuestion?.text ?? "",
        lane: lastAnswer.lane,
        route: lastAnswer.route,
        plan: lastAnswer.plan,
        result_summary: lastAnswer.evidence?.summary ?? null
      };
    }
  }

  let zone_notice: string | null = null;
  const disagreement = await zoneDisagreement(deps.main, now).catch(() => null);
  if (disagreement) {
    zone_notice = `Your wearables have reported ${formatOffset(disagreement.providerOffset)} since ${formatDay(disagreement.since.toISOString().slice(0, 10))}, but this Mac is set to ${timezone}. Which time zone should I use? You can set it in the assistant's settings.`;
  }

  const p = profileRows[0] ?? { age_years: null, recorded_sex: null, hospitals: [] };
  return {
    now_utc: now.toISOString(),
    timezone,
    local_now: `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parts.weekday]} ${formatDay(today)}, ${parts.time}`,
    today,
    time_ranges,
    freshness,
    freshness_text: freshnessText(freshness),
    data_inventory: inventory,
    inventory_text: inventoryText(inventory),
    profile: { age_years: p.age_years, recorded_sex: p.recorded_sex, hospitals: p.hospitals ?? [] },
    memory,
    history: history.slice(-12),
    history_summary,
    last_evidence,
    zone_notice
  };
}
