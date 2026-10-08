import { lookup } from "node:dns/promises";
import { SyncRunStore } from "../load/sync-runs";
import type { PostgresConfig } from "../load/config";

export interface Job {
  name: string;
  // How often to run once healthy. Overdue jobs run at the next tick, which
  // is what makes catch-up after sleep/shutdown automatic.
  intervalMs: number;
  // Runs only after a wake/startup, not on the interval (e.g. nudging the
  // wearables backend so it doesn't wait for its own hourly schedule).
  onWakeOnly?: boolean;
  // Delay after wake/startup before this job may run, so a job that reads
  // what another job triggered gives it time to land.
  wakeDelayMs?: number;
  run: () => Promise<unknown>;
}

const TICK_MS = 30 * 1000;
// A tick arriving this late means the process was suspended (lid closed) —
// treat it like a fresh start.
const WAKE_GAP_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const NETWORK_PROBE_HOST = "api.ouraring.com";

interface JobState {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  failures: number;
  running: boolean;
  wakePending: boolean;
}

// Right after wake the Wi-Fi is often not back yet; running then just
// produces failures. DNS is a cheap, request-free signal that it's back.
async function networkUp(): Promise<boolean> {
  try {
    await lookup(NETWORK_PROBE_HOST);
    return true;
  } catch {
    return false;
  }
}

export class Scheduler {
  private readonly runs: SyncRunStore;
  private readonly state = new Map<string, JobState>();
  private lastTickAt = Date.now();
  private wokeAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    postgresConfig: PostgresConfig,
    private readonly jobs: Job[]
  ) {
    this.runs = new SyncRunStore(postgresConfig);
  }

  async start(): Promise<void> {
    await this.runs.markInterruptedRuns();
    for (const job of this.jobs) {
      const lastSuccess = await this.runs.lastSuccessAt(job.name);
      this.state.set(job.name, {
        lastSuccessAt: lastSuccess?.getTime() ?? null,
        lastAttemptAt: null,
        failures: 0,
        running: false,
        wakePending: true
      });
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // Run a job now regardless of schedule (e.g. "Sync now" button).
  async runNow(name: string, trigger = "manual"): Promise<void> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`Unknown job: ${name}`);
    await this.execute(job, trigger);
  }

  private markWake(): void {
    this.wokeAt = Date.now();
    for (const state of this.state.values()) {
      state.wakePending = true;
      state.failures = 0;
    }
  }

  private due(job: Job, state: JobState, now: number): boolean {
    if (state.running) return false;
    if (state.wakePending) return now - this.wokeAt >= (job.wakeDelayMs ?? 0);

    // Failed runs retry with exponential backoff (1, 2, 4 ... 30 min),
    // including wake-only jobs, until one succeeds.
    if (state.failures > 0 && state.lastAttemptAt) {
      const backoff = Math.min(60 * 1000 * 2 ** (state.failures - 1), MAX_BACKOFF_MS);
      return now - state.lastAttemptAt >= backoff;
    }
    if (job.onWakeOnly) return false;
    return !state.lastSuccessAt || now - state.lastSuccessAt >= job.intervalMs;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTickAt > WAKE_GAP_MS) {
      console.log(`Detected wake after ${Math.round((now - this.lastTickAt) / 60000)} min — catching up`);
      this.markWake();
    }
    this.lastTickAt = now;

    const dueJobs = this.jobs.filter((job) => this.due(job, this.state.get(job.name)!, now));
    if (dueJobs.length === 0) return;
    if (!(await networkUp())) return;

    for (const job of dueJobs) {
      const trigger = this.state.get(job.name)!.wakePending ? "wake" : "schedule";
      void this.execute(job, trigger);
    }
  }

  private async execute(job: Job, trigger: string): Promise<void> {
    const state = this.state.get(job.name)!;
    if (state.running) return;
    state.running = true;
    state.lastAttemptAt = Date.now();
    state.wakePending = false;

    // Executions are fire-and-forget, so nothing here may throw: a database
    // hiccup while logging must count as a failed run (and be retried), not
    // become an unhandled rejection that takes the app down.
    let runId: number | null = null;
    try {
      runId = await this.runs.start(job.name, trigger);
      const detail = await job.run();
      await this.runs.succeed(runId, detail);
      state.lastSuccessAt = Date.now();
      state.failures = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Job ${job.name} failed:`, message);
      if (runId !== null) await this.runs.fail(runId, message).catch(() => {});
      state.failures += 1;
    } finally {
      state.running = false;
    }
  }
}
