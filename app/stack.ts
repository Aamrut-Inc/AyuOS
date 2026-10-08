import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPostgresReachable, type PostgresConfig } from "../load/config";

// Brings the local Docker stack (Postgres x2, Redis, wearables backend) back
// after a reboot or after Docker Desktop was quit, so the app can run
// unattended from a login agent. Containers are started by name rather than
// via `docker compose up`, because the installed copy of the app doesn't
// carry the build context — `up` would try to rebuild.

const DOCKER_WAIT_MS = 3 * 60 * 1000;
const POSTGRES_WAIT_MS = 2 * 60 * 1000;
const POLL_MS = 3000;

function composeContainerNames(): string[] {
  const compose = readFileSync(join(import.meta.dir, "..", "docker-compose.yml"), "utf8");
  return [...compose.matchAll(/^\s*container_name:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

async function run(cmd: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false; // binary missing from PATH
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(POLL_MS);
  }
  return check();
}

export async function ensureDocker(): Promise<void> {
  if (await run(["docker", "info"])) return;
  if (process.platform === "darwin") {
    console.log("Docker is not running — launching Docker Desktop...");
    await run(["open", "-g", "-a", "Docker"]);
  }
  if (!(await waitFor(() => run(["docker", "info"]), DOCKER_WAIT_MS))) {
    throw new Error("Docker did not come up. Open Docker Desktop and the app will retry.");
  }
}

export async function ensureStack(postgresConfig: PostgresConfig): Promise<void> {
  await ensureDocker();
  const names = composeContainerNames();
  if (!(await run(["docker", "start", ...names]))) {
    console.warn(
      "Some containers could not be started. If this is a fresh clone, run scripts/start.command once to create them."
    );
  }

  const postgresUp = () =>
    assertPostgresReachable(postgresConfig).then(
      () => true,
      () => false
    );
  if (!(await waitFor(postgresUp, POSTGRES_WAIT_MS))) {
    await assertPostgresReachable(postgresConfig); // throws with the actionable message
  }
}
