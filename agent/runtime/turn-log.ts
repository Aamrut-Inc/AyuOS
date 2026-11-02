import type { SQL } from "bun";

// Everything one turn does, logged to agent.tool_runs (16.2) and kept in
// memory for the verifier: each tool, SQL query and Python run gets an
// evidence id, so every number in the answer can be traced back (12.2).

export type RunKind = "model" | "tool" | "sql" | "python" | "search" | "fetch" | "redaction" | "safety";

export interface Evidence {
  id: string; // short id used in prompts: e1, e2, ...
  kind: RunKind;
  name: string;
  input: unknown;
  output: unknown;
  provenance?: unknown;
  searched?: unknown;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

function truncate(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length <= MAX_OUTPUT_BYTES) return value;
  return { truncated: true, bytes: text.length, preview: text.slice(0, 20_000) };
}

export class CostCapReached extends Error {}

export class TurnLog {
  readonly evidence = new Map<string, Evidence>();
  private counter = 0;
  costUsd = 0;
  tokens = 0;
  modelCalls = 0;
  readonly statusLines: string[] = [];

  constructor(
    private readonly rw: SQL | null,
    public turnId: number | null,
    private readonly costCapUsd = 0.5,
    readonly signal: AbortSignal = new AbortController().signal,
    private readonly onStatus: (line: string) => void = () => {},
    // Applies even when a model's price is unknown.
    private readonly tokenCap = 400_000
  ) {}

  status(line: string): void {
    this.statusLines.push(line);
    this.onStatus(line);
  }

  overBudget(): boolean {
    return this.costUsd >= this.costCapUsd || this.tokens >= this.tokenCap;
  }

  private async write(row: {
    kind: RunKind; name: string; input?: unknown; output?: unknown; evidenceId?: string | null; status: string;
    error?: string | null; latencyMs?: number | null; tokensIn?: number | null; tokensOut?: number | null; costUsd?: number | null;
  }): Promise<void> {
    if (!this.rw) return;
    try {
      await this.rw`
        INSERT INTO agent.tool_runs (turn_id, kind, name, input, output, evidence_id, status, error, latency_ms, tokens_in, tokens_out, cost_usd)
        VALUES (${this.turnId}, ${row.kind}, ${row.name}, ${JSON.stringify(row.input ?? null)}::text::jsonb,
                ${JSON.stringify(truncate(row.output) ?? null)}::text::jsonb, ${row.evidenceId ?? null}, ${row.status}, ${row.error ?? null},
                ${row.latencyMs ?? null}, ${row.tokensIn ?? null}, ${row.tokensOut ?? null}, ${row.costUsd ?? null})
      `;
    } catch (error) {
      console.error("Could not log agent run:", error instanceof Error ? error.message : error);
    }
  }

  // Records a result as evidence and returns its id.
  async addEvidence(kind: RunKind, name: string, input: unknown, output: unknown, extra: { provenance?: unknown; searched?: unknown; latencyMs?: number } = {}): Promise<string> {
    const id = `e${++this.counter}`;
    this.evidence.set(id, { id, kind, name, input, output, provenance: extra.provenance, searched: extra.searched });
    const globalId = `t${this.turnId ?? "x"}-${id}-${crypto.randomUUID().slice(0, 8)}`;
    await this.write({ kind, name, input, output: { output, provenance: extra.provenance, searched: extra.searched }, evidenceId: globalId, status: "ok", latencyMs: extra.latencyMs });
    return id;
  }

  async failure(kind: RunKind, name: string, input: unknown, error: string, latencyMs?: number): Promise<void> {
    await this.write({ kind, name, input, status: "error", error, latencyMs });
  }

  async model(name: string, input: unknown, output: unknown, usage: { tokensIn: number; tokensOut: number; costUsd: number; latencyMs: number }, error?: string): Promise<void> {
    this.costUsd += usage.costUsd;
    this.tokens += usage.tokensIn + usage.tokensOut;
    this.modelCalls += 1;
    await this.write({ kind: "model", name, input, output, status: error ? "error" : "ok", error, latencyMs: usage.latencyMs, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd });
  }

  // Redaction events record the kind of identifier removed, never the value.
  async redaction(purpose: string, events: Array<{ kind: string; count: number }>): Promise<void> {
    if (events.length) await this.write({ kind: "redaction", name: purpose, input: events, status: "ok" });
  }

  async safety(name: string, detail: unknown): Promise<void> {
    await this.write({ kind: "safety", name, input: detail, status: "ok" });
  }

  get(ids: string[]): Evidence[] {
    return ids.map((id) => this.evidence.get(id)).filter((e): e is Evidence => Boolean(e));
  }

  all(): Evidence[] {
    return [...this.evidence.values()];
  }
}
