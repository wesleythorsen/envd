/**
 * Integration test: daemon lifecycle commands
 *
 * Requires a fully-built dist/ (npm run build). Skipped on win32.
 * Isolates from the real ~/.d-env by setting D_ENV_HOME to a per-test tmpdir.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const isWin32 = process.platform === "win32";
const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, "../../");
const cliPath = join(repoRoot, "dist/cli/main.js");

function cliCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

describe.skipIf(isWin32)("daemon lifecycle integration", () => {
  let tmpHome: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    // Ensure we have a built dist.
    if (!existsSync(cliPath)) {
      throw new Error(
        `dist/cli/main.js not found — run 'npm run build' first.\n` +
          `Expected: ${cliPath}`,
      );
    }
    tmpHome = mkdtempSync(join(tmpdir(), "d-env-lifecycle-test-"));
    env = { D_ENV_HOME: tmpHome };
  });

  afterAll(() => {
    // Best-effort cleanup: try to stop the daemon if still running.
    cliCommand(["daemon", "stop"], env);
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it("status shows not running before start", () => {
    const { stdout, status } = cliCommand(["daemon", "status", "--json"], env);
    expect(status).toBe(0);
    // as-cast justified: JSON.parse returns unknown; we guard immediately.
    const data = JSON.parse(stdout) as Record<string, unknown>;
    expect(data["status"]).toBe("not_running");
  });

  it("start starts the daemon and status shows running", () => {
    const startResult = cliCommand(["daemon", "start", "--json"], env);
    expect(startResult.status).toBe(0);
    const startData = JSON.parse(startResult.stdout) as Record<string, unknown>;
    expect(startData["status"]).toBe("started");
    expect(typeof startData["pid"]).toBe("number");

    const statusResult = cliCommand(["daemon", "status", "--json"], env);
    expect(statusResult.status).toBe(0);
    const statusData = JSON.parse(statusResult.stdout) as Record<
      string,
      unknown
    >;
    expect(statusData["status"]).toBe("running");
    expect(typeof statusData["pid"]).toBe("number");
  });

  it("start is idempotent — returns already_running when daemon is up", () => {
    const result = cliCommand(["daemon", "start", "--json"], env);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(data["status"]).toBe("already_running");
  });

  it("stop stops the daemon cleanly", () => {
    const stopResult = cliCommand(["daemon", "stop", "--json"], env);
    expect(stopResult.status).toBe(0);
    const stopData = JSON.parse(stopResult.stdout) as Record<string, unknown>;
    expect(stopData["status"]).toBe("stopped");
  });

  it("status shows not running after stop", () => {
    const result = cliCommand(["daemon", "status", "--json"], env);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(data["status"]).toBe("not_running");
  });

  it("stop is idempotent — returns not_running when daemon is already stopped", () => {
    const result = cliCommand(["daemon", "stop", "--json"], env);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(data["status"]).toBe("not_running");
  });

  it("restart starts the daemon after stop", () => {
    // Ensure stopped.
    cliCommand(["daemon", "stop"], env);

    const result = cliCommand(["daemon", "restart", "--json"], env);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(data["status"]).toBe("started");

    // Cleanup.
    cliCommand(["daemon", "stop"], env);
  });
});
