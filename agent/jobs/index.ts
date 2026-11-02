import type { SQL } from "bun";
import { extractNotes } from "./notes";
import { rebuildTzHistory } from "./tz-history";

// Background work that keeps the agent's tables current. Called from the
// app's sync code (app/server.ts) and from the nightly scheduler job. All of
// it runs with the app's main role; failures are logged by the caller and
// never fail the sync that triggered them.

const listeners = new Set<() => void>();

// The context builder caches data_inventory until the next sync (section 17).
export function onDataChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function dataChanged(): void {
  for (const listener of listeners) listener();
}

export async function refreshWearableDaily(main: SQL): Promise<{ ms: number; concurrent: boolean }> {
  const started = performance.now();
  const [state] = await main`
    SELECT c.relispopulated AS populated FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'agent' AND c.relname = 'v_wearable_daily'
  `;
  // CONCURRENTLY keeps the view readable during the refresh, but needs a
  // first plain refresh to populate it.
  const concurrent = Boolean(state?.populated);
  // Fresh statistics keep the planner on hash joins: right after a large
  // import, missing stats made it pick a nested loop (2 s -> 24 s).
  await main.unsafe("ANALYZE timeseries.readings, wearables.records, agent.metric_catalog");
  await main.unsafe(`REFRESH MATERIALIZED VIEW ${concurrent ? "CONCURRENTLY " : ""}agent.v_wearable_daily`);
  return { ms: Math.round(performance.now() - started), concurrent };
}

export async function ensureWearableDailyPopulated(main: SQL): Promise<void> {
  const [state] = await main`
    SELECT c.relispopulated AS populated FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'agent' AND c.relname = 'v_wearable_daily'
  `;
  if (state && !state.populated) await refreshWearableDaily(main);
}

// After an Oura/Whoop sync or an Apple Health upload.
export async function afterWearableData(main: SQL): Promise<Record<string, unknown>> {
  const tz = await rebuildTzHistory(main);
  const refresh = await refreshWearableDaily(main);
  dataChanged();
  return { tz_intervals: tz.intervals, refresh_ms: refresh.ms };
}

// After an EHR import (new attachments to extract) or a lab PDF review.
export async function afterClinicalData(main: SQL): Promise<Record<string, unknown>> {
  const notes = await extractNotes(main);
  dataChanged();
  return { notes_extracted: notes.extracted, notes_attempted: notes.attempted };
}

// Retention (16.2): agent log rows older than the setting (default 90 days).
// Only agent log tables; health data is never touched.
export async function cleanupLogs(main: SQL): Promise<number> {
  const [setting] = await main`SELECT value #>> '{}' AS days FROM agent.user_settings WHERE key = 'log_retention_days'`;
  const days = Number(setting?.days ?? 90);
  const deleted = await main`
    DELETE FROM agent.conversations c
    WHERE NOT EXISTS (SELECT 1 FROM agent.turns t WHERE t.conversation_id = c.id AND t.created_at > now() - make_interval(days => ${days}))
      AND c.started_at < now() - make_interval(days => ${days})
    RETURNING c.id
  `;
  await main`DELETE FROM agent.tool_runs WHERE created_at < now() - make_interval(days => ${days})`;
  // Symptom facts expire after 30 days (13.1).
  await main`UPDATE agent.memory_facts SET active = false WHERE active AND expires_at IS NOT NULL AND expires_at < now()`;
  return deleted.length;
}

export async function nightly(main: SQL): Promise<Record<string, unknown>> {
  const wearable = await afterWearableData(main);
  const clinical = await afterClinicalData(main);
  const removedConversations = await cleanupLogs(main);
  return { ...wearable, ...clinical, removed_conversations: removedConversations };
}
