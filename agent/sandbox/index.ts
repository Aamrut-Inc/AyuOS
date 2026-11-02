import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { Subprocess } from "bun";

// Section 10.6: model-written Python runs in Pyodide in a separate process,
// started under a macOS sandbox profile: no network, no file writes, file
// reads limited to the system, the Bun runtime, Pyodide and ayu_stats. A run
// is stopped after 20 s and the process restarted; a process growing past
// the memory ceiling is killed. One process is kept warm (start ~2 s).

const CHILD = join(import.meta.dir, "child.ts");
const TIMEOUT_MS = 20_000;
// Pyodide's heap plus the Bun runtime; analysis data is capped well below.
const MEMORY_LIMIT_KB = 1_200_000;

function pyodideDir(): string {
  return dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
}

function wheelsCached(): boolean {
  const dir = pyodideDir();
  const files = readdirSync(dir);
  return ["numpy-", "pandas-", "scipy-"].every((prefix) => files.some((f) => f.startsWith(prefix) && f.endsWith(".whl")));
}

// Writes outside these are denied; reads of the user's home are limited to
// what the runtime needs. Seatbelt applies the last matching rule.
export function sandboxProfile(): string {
  const home = process.env.HOME ?? "/Users";
  const bunDir = dirname(process.execPath);
  const allowRead = [pyodideDir(), join(import.meta.dir), dirname(dirname(bunDir)), bunDir]
    .map((p) => `(subpath "${p.replace(/"/g, "")}")`)
    .join(" ");
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))
(deny file-read* (subpath "${home}"))
(allow file-read* ${allowRead} (literal "${home}") (subpath "${join(home, ".bun")}"))
(deny process-exec*)
(allow process-exec* (literal "${process.execPath}"))
`;
}

export interface SandboxResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  stdout?: string;
  timedOut?: boolean;
  latencyMs: number;
}

type Pending = { resolve: (r: SandboxResult) => void; started: number; timer: ReturnType<typeof setTimeout> };

class SandboxProcess {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private memoryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly useOsSandbox = process.platform === "darwin") {}

  private async prefetch(): Promise<void> {
    // The first start downloads numpy/pandas/scipy wheels into node_modules
    // (outside the sandbox, no user code). Afterwards no network is needed.
    if (wheelsCached()) return;
    const proc = Bun.spawn([process.execPath, "-e", `const { loadPyodide } = await import("pyodide"); const py = await loadPyodide(); await py.loadPackage(["numpy", "pandas", "scipy"], { messageCallback: () => {} });`], { stdout: "ignore", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`Could not prepare the Python sandbox: ${await new Response(proc.stderr).text()}`);
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await this.prefetch();
      const command = this.useOsSandbox
        ? ["/usr/bin/sandbox-exec", "-p", sandboxProfile(), process.execPath, CHILD]
        : [process.execPath, CHILD];
      const proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" } });
      this.proc = proc;
      let resolveReady!: () => void;
      let rejectReady!: (e: Error) => void;
      const readyPromise = new Promise<void>((res, rej) => {
        resolveReady = res;
        rejectReady = rej;
      });
      (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stdout) {
          this.buffer += decoder.decode(chunk);
          let nl: number;
          while ((nl = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, nl);
            this.buffer = this.buffer.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: any;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.ready) resolveReady();
            if (this.proc !== proc) continue;
            const p = this.pending.get(msg.id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(msg.id);
              p.resolve({ ok: msg.ok, result: msg.result, error: msg.error, stdout: msg.stdout, latencyMs: Math.round(performance.now() - p.started) });
            }
          }
        }
      })();
      proc.exited.then(async (code) => {
        const stderr = await new Response(proc.stderr).text().catch(() => "");
        rejectReady(new Error(`Python sandbox exited (${code}): ${stderr.slice(-500)}`));
        // A process already replaced (after a timeout kill) must not reset its successor.
        if (this.proc === proc) this.reset(`the sandbox process stopped (${code})`);
      });
      this.memoryTimer = setInterval(() => this.checkMemory(), 500);
      await Promise.race([readyPromise, Bun.sleep(60_000).then(() => { throw new Error("Python sandbox did not start within 60 s"); })]);
    })();
    this.ready.catch(() => this.reset("start failed"));
    return this.ready;
  }

  private checkMemory(): void {
    if (!this.proc || this.pending.size === 0) return;
    const ps = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(this.proc.pid)], { stdout: "pipe" });
    const rss = Number(ps.stdout.toString().trim());
    if (rss > MEMORY_LIMIT_KB) {
      this.kill(`memory limit exceeded (${Math.round(rss / 1024)} MB)`);
    }
  }

  private reset(reason: string): void {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.memoryTimer = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: reason, latencyMs: Math.round(performance.now() - p.started) });
    }
    this.pending.clear();
    this.proc = null;
    this.ready = null;
    this.buffer = "";
  }

  kill(reason: string): void {
    const proc = this.proc;
    this.reset(reason);
    proc?.kill(9);
  }

  async run(code: string, data: Record<string, unknown[]>, timeoutMs = TIMEOUT_MS): Promise<SandboxResult> {
    await this.start();
    const id = this.nextId++;
    return new Promise<SandboxResult>((resolve) => {
      const started = performance.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, timedOut: true, error: `the Python code ran for more than ${timeoutMs / 1000} s and was stopped`, latencyMs: timeoutMs });
        this.kill("timeout");
      }, timeoutMs);
      this.pending.set(id, { resolve, started, timer });
      this.proc!.stdin.write(`${JSON.stringify({ id, code, data })}\n`);
      this.proc!.stdin.flush();
    });
  }
}

let shared: SandboxProcess | null = null;

export function sandbox(): SandboxProcess {
  shared ??= new SandboxProcess();
  return shared;
}

export function warmSandbox(): void {
  sandbox().start().catch((error) => console.warn("Python sandbox unavailable:", error instanceof Error ? error.message : error));
}

export function sandboxAvailable(): boolean {
  return existsSync(CHILD);
}

export { SandboxProcess };
