import { SQL } from "bun";
import type { PostgresConfig } from "./config";

export type SyncRunStatus = "running" | "success" | "failed";

export interface SyncRunSummary {
  job: string;
  lastStatus: SyncRunStatus;
  lastStartedAt: string;
  lastFinishedAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
}

// Runs left 'running' by a process that died mid-job (crash, laptop lid
// closed then killed) are marked failed on startup so they don't show as
// in-progress forever.
const STALE_RUNNING_MESSAGE = "Interrupted: the app stopped before this run finished";

export class SyncRunStore {
  private readonly sql: SQL;

  constructor(config: PostgresConfig) {
    this.sql = new SQL(config.connectionString);
  }

  async start(job: string, trigger: string): Promise<number> {
    const [row] = await this.sql`
      INSERT INTO ops.sync_runs (job, trigger, status)
      VALUES (${job}, ${trigger}, 'running')
      RETURNING id
    `;
    return Number(row.id);
  }

  async succeed(id: number, detail: unknown): Promise<void> {
    await this.sql`
      UPDATE ops.sync_runs
      SET status = 'success', finished_at = now(), detail = ${JSON.stringify(detail ?? null)}::jsonb
      WHERE id = ${id}
    `;
  }

  async fail(id: number, error: string): Promise<void> {
    await this.sql`
      UPDATE ops.sync_runs
      SET status = 'failed', finished_at = now(), error = ${error}
      WHERE id = ${id}
    `;
  }

  async markInterruptedRuns(): Promise<void> {
    await this.sql`
      UPDATE ops.sync_runs
      SET status = 'failed', finished_at = now(), error = ${STALE_RUNNING_MESSAGE}
      WHERE status = 'running'
    `;
  }

  async lastSuccessAt(job: string): Promise<Date | null> {
    const [row] = await this.sql`
      SELECT max(finished_at) AS at FROM ops.sync_runs
      WHERE job = ${job} AND status = 'success'
    `;
    return row?.at ? new Date(row.at) : null;
  }

  async summaries(): Promise<SyncRunSummary[]> {
    const rows = await this.sql`
      WITH latest AS (
        SELECT DISTINCT ON (job) job, status, started_at, finished_at, error
        FROM ops.sync_runs
        ORDER BY job, started_at DESC
      ),
      last_success AS (
        SELECT job, max(finished_at) AS at
        FROM ops.sync_runs WHERE status = 'success'
        GROUP BY job
      ),
      failures AS (
        SELECT r.job, count(*)::int AS n
        FROM ops.sync_runs r
        LEFT JOIN last_success s ON s.job = r.job
        WHERE r.status = 'failed' AND (s.at IS NULL OR r.started_at > s.at)
        GROUP BY r.job
      )
      SELECT l.job, l.status, l.started_at, l.finished_at, l.error,
             s.at AS last_success_at, coalesce(f.n, 0) AS consecutive_failures
      FROM latest l
      LEFT JOIN last_success s ON s.job = l.job
      LEFT JOIN failures f ON f.job = l.job
      ORDER BY l.job
    `;
    return rows.map((row: any) => ({
      job: row.job,
      lastStatus: row.status,
      lastStartedAt: new Date(row.started_at).toISOString(),
      lastFinishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      lastError: row.error,
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      consecutiveFailures: Number(row.consecutive_failures)
    }));
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
