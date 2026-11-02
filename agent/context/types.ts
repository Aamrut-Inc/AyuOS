import type { TimeRange } from "./time-phrases";

// Section 7.1: the facts every step of a turn sees. Built once, in code,
// before any model call.

export interface FreshnessRow {
  kind: "wearable" | "hospital" | "lab_pdf";
  source: string;
  display_name: string;
  status: string;
  sandbox: boolean;
  last_data_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  item_count: number | null;
  // Derived: stale when a provider needs reconnecting or has no data in 48 h.
  stale: boolean;
}

export interface InventoryItem {
  domain: string;
  source: string;
  count: number;
  first: string | null;
  last: string | null;
}

export interface MemoryFact {
  id: number;
  fact_text: string;
  category: string;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface LastEvidence {
  turn_id: number;
  question: string;
  lane: string | null;
  route: unknown;
  plan: unknown;
  result_summary: string | null;
}

export interface TurnContext {
  now_utc: string;
  timezone: string;
  local_now: string; // "Sun 1 Nov 2026, 09:15"
  today: string; // local date
  time_ranges: TimeRange[];
  freshness: FreshnessRow[];
  freshness_text: string;
  data_inventory: InventoryItem[];
  inventory_text: string;
  profile: { age_years: number | null; recorded_sex: string | null; hospitals: Array<{ source: string; name: string; last_import: string | null }> };
  memory: MemoryFact[];
  history: HistoryTurn[];
  history_summary: string | null;
  last_evidence: LastEvidence | null;
  zone_notice: string | null; // 5.5: the Mac's zone and the wearables disagree
}
