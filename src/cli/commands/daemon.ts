import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlClient } from "../../ipc/control-client.js";
import { pidFile, portsFile } from "../../shared/paths.js";
import { DEnvError } from "../../shared/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reads the PID file and returns the pid, or undefined if missing/unparseable. */
function readPid(): number | undefined {
  try {
    const raw = readFileSync(pidFile(), "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? undefined : pid;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/** Returns true if a process with the given PID is alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    // EPERM means process exists but we can't signal it; treat as alive.
    return true;
  }
}

interface Ports {
  control: number;
  webdav: number;
}

function readPorts(): Ports | undefined {
  try {
    // as-cast justified: JSON.parse returns unknown; we narrow after.
    const parsed = JSON.parse(readFileSync(portsFile(), "utf-8")) as Record<
      string,
      unknown
    >;
    const control = parsed["control"];
    const webdav = parsed["webdav"];
    if (typeof control === "number" && typeof webdav === "number") {
      return { control, webdav };
    }
    return undefined;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/**
 * Resolves the path to the compiled daemon entry point.
 *
 * When running from compiled dist, this file is dist/cli/commands/daemon.js
 * and the daemon is at dist/daemon/main.js.
 * When running via tsx from src, the compiled dist may not exist yet —
 * in that case we print a helpful error.
 */
function resolveDaemonPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/cli/commands/daemon.js → dist/daemon/main.js
  const candidate = resolve(dirname(thisFile), "../../daemon/main.js");
  if (existsSync(candidate)) {
    return candidate;
  }
  process.stderr.write(
    "Cannot locate dist/daemon/main.js — run `npm run build` first.\n",
  );
  process.exit(1);
}

/**
 * Polls /v1/health for up to maxMs. Returns true if it becomes healthy,
 * false if the deadline passes.
 */
async function waitForHealthy(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 200));
    // Re-read ports each iteration: daemon may have just written the file.
    const ports = readPorts();
    if (ports === undefined) {
      continue;
    }
    try {
      const client = createControlClient({
        baseUrl: `http://127.0.0.1:${ports.control}`,
      });
      await client.health();
      return true;
    } catch {
      // Not up yet; keep polling.
    }
  }
  return false;
}

/**
 * Waits for the process to stop (pid file to disappear or kill(pid,0)→ESRCH)
 * for up to maxMs. Returns true if it stopped, false if still alive.
 */
async function waitForDead(pid: number, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 200));
    if (!isPidAlive(pid)) {
      return true;
    }
  }
  return false;
}

/** Prints output in human or JSON form. */
function out(human: string, jsonData?: unknown, useJson?: boolean): void {
  if (useJson === true && jsonData !== undefined) {
    process.stdout.write(JSON.stringify(jsonData) + "\n");
  } else {
    process.stdout.write(human + "\n");
  }
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function doStart(opts: { json?: boolean }): Promise<void> {
  // Check if already running.
  const pid = readPid();
  if (pid !== undefined && isPidAlive(pid)) {
    const ports = readPorts();
    try {
      const existingClient = createControlClient();
      await existingClient.health();
      // It's alive and responding.
      out(
        `d-envd already running (pid=${pid}, control=${ports?.control ?? "?"}, webdav=${ports?.webdav ?? "?"})`,
        { status: "already_running", pid, ports },
        opts.json,
      );
      process.exit(0);
    } catch {
      // Pid alive but not responding — fall through and try to restart.
    }
  }

  const daemonPath = resolveDaemonPath();
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const healthy = await waitForHealthy(5000);
  if (!healthy) {
    process.stderr.write("d-envd did not become healthy within 5 seconds.\n");
    process.exit(1);
  }

  const startedPid = readPid();
  const startedPorts = readPorts();
  out(
    `d-envd started (pid=${startedPid ?? "?"}, control=${startedPorts?.control ?? "?"}, webdav=${startedPorts?.webdav ?? "?"})`,
    { status: "started", pid: startedPid, ports: startedPorts },
    opts.json,
  );
}

/**
 * Core stop logic. Returns "not_running", "stopped", or "killed".
 * Exits with code 1 only when SIGKILL is needed (daemon is stuck).
 */
async function stopDaemon(): Promise<"not_running" | "stopped" | "killed"> {
  const pid = readPid();
  if (pid === undefined || !isPidAlive(pid)) {
    return "not_running";
  }

  // Try graceful shutdown via the control API.
  let stopped = false;
  try {
    const client = createControlClient();
    await client.shutdown();
    stopped = await waitForDead(pid, 5000);
  } catch (err: unknown) {
    // If the client can't connect, treat as already stopped.
    if (err instanceof DEnvError && err.code === "daemon_unreachable") {
      stopped = true;
    }
  }

  if (!stopped) {
    // Fall back to SIGTERM.
    process.stderr.write("Graceful shutdown timed out; sending SIGTERM.\n");
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have just died.
    }
    stopped = await waitForDead(pid, 5000);
  }

  if (!stopped) {
    // Last resort: SIGKILL.
    process.stderr.write("SIGTERM timed out; sending SIGKILL.\n");
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may have just died.
    }
    return "killed";
  }

  return "stopped";
}

async function doStop(opts: { json?: boolean }): Promise<void> {
  const result = await stopDaemon();
  if (result === "not_running") {
    out("d-envd is not running", { status: "not_running" }, opts.json);
    process.exit(0);
  }
  if (result === "killed") {
    out("d-envd stopped (SIGKILL)", { status: "killed" }, opts.json);
    process.exit(1);
  }
  out("d-envd stopped", { status: "stopped" }, opts.json);
}

async function doStatus(opts: { json?: boolean }): Promise<void> {
  const pid = readPid();
  if (pid === undefined || !isPidAlive(pid)) {
    out("d-envd is not running", { status: "not_running" }, opts.json);
    return;
  }

  const ports = readPorts();
  let health: { ok: boolean; version: string; uptimeSec: number } | undefined;
  try {
    const client = createControlClient();
    health = await client.health();
  } catch {
    // Daemon is alive by PID but not responding.
  }

  if (opts.json === true) {
    out(
      "",
      {
        status: "running",
        pid,
        ports,
        version: health?.version,
        uptimeSec: health?.uptimeSec,
      },
      true,
    );
  } else {
    process.stdout.write(`d-envd is running\n`);
    process.stdout.write(`  pid:          ${pid}\n`);
    process.stdout.write(`  control port: ${ports?.control ?? "(unknown)"}\n`);
    process.stdout.write(`  webdav port:  ${ports?.webdav ?? "(unknown)"}\n`);
    process.stdout.write(`  version:      ${health?.version ?? "(unknown)"}\n`);
    process.stdout.write(
      `  uptime:       ${health !== undefined ? `${health.uptimeSec}s` : "(unknown)"}\n`,
    );
  }
}

async function doRestart(opts: { json?: boolean }): Promise<void> {
  // Stop without printing so only doStart's output reaches stdout.
  const stopResult = await stopDaemon();
  if (stopResult === "killed") {
    process.stderr.write("Warning: daemon required SIGKILL during restart.\n");
  }
  // Brief settle delay to let ports/sockets fully release.
  await new Promise<void>((r) => setTimeout(r, 250));
  await doStart(opts);
}

// ---------------------------------------------------------------------------
// Commander wiring
// ---------------------------------------------------------------------------

export function buildDaemonCommand(): Command {
  const daemon = new Command("daemon").description(
    "Manage the d-envd background daemon",
  );

  daemon
    .command("start")
    .description("Start the daemon if not already running")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      await doStart(opts);
    });

  daemon
    .command("stop")
    .description("Stop the running daemon")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      await doStop(opts);
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      await doStatus(opts);
    });

  daemon
    .command("restart")
    .description("Stop then start the daemon")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      await doRestart(opts);
    });

  return daemon;
}
