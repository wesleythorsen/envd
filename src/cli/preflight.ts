import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlClient } from "../ipc/control-client.js";
import { createControlClient } from "../ipc/control-client.js";
import type { MountAdapter } from "../mount/adapter.js";
import { createMountAdapter } from "../mount/index.js";
import { EnvdError } from "../shared/errors.js";
import { mountPath, portsFile } from "../shared/paths.js";

export interface CliPreflightOptions {
  readonly action: string;
  readonly ensureMount?: boolean | undefined;
  readonly noAutostart?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface CliPreflightResult {
  readonly client: ControlClient;
  readonly daemon: "already_healthy" | "started";
  readonly mount:
    | { readonly checked: false }
    | {
        readonly checked: true;
        readonly path: string;
        readonly mounted: boolean;
      };
}

export interface CliPreflightDeps {
  readonly createClient?: () => ControlClient;
  readonly startDaemon?: () => Promise<void>;
  readonly createMountAdapter?: () => Promise<MountAdapter>;
  readonly mountPath?: () => string;
  readonly webdavUrl?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isDaemonUnreachable(error: unknown): boolean {
  return error instanceof EnvdError && error.code === "daemon_unreachable";
}

async function healthyClient(
  createClient: () => ControlClient,
): Promise<ControlClient> {
  const client = createClient();
  await client.health();
  return client;
}

function resolveDaemonPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const candidate = resolve(dirname(thisFile), "../daemon/main.js");
  if (existsSync(candidate)) {
    return candidate;
  }
  throw new EnvdError("cannot locate dist/daemon/main.js; run npm run build", {
    code: "daemon_unreachable",
    details: { path: candidate },
  });
}

function startDetachedDaemon(): Promise<void> {
  const child = spawn(process.execPath, [resolveDaemonPath()], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return Promise.resolve();
}

function defaultWebdavUrl(): string {
  // as-cast justified: ports.json is a daemon-owned serialization boundary.
  const parsed = JSON.parse(readFileSync(portsFile(), "utf-8")) as Record<
    string,
    unknown
  >;
  const webdav = parsed["webdav"];
  if (typeof webdav !== "number") {
    throw new EnvdError("ports file is missing webdav port", {
      code: "daemon_unreachable",
    });
  }
  return `http://127.0.0.1:${webdav}/`;
}

async function waitForHealthyClient(
  createClient: () => ControlClient,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<ControlClient | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await healthyClient(createClient);
    } catch (error: unknown) {
      if (!isDaemonUnreachable(error)) {
        throw error;
      }
    }
    await sleep(100);
  }
  return null;
}

async function ensureDaemon(
  options: CliPreflightOptions,
  deps: CliPreflightDeps,
): Promise<{
  readonly client: ControlClient;
  readonly daemon: "already_healthy" | "started";
}> {
  const createClient = deps.createClient ?? createControlClient;
  try {
    return {
      client: await healthyClient(createClient),
      daemon: "already_healthy",
    };
  } catch (error: unknown) {
    if (!isDaemonUnreachable(error)) {
      throw error;
    }
  }

  if (options.noAutostart === true) {
    throw new EnvdError(
      `cannot ${options.action}: daemon is not running and autostart is disabled`,
      { code: "daemon_unreachable" },
    );
  }

  await (deps.startDaemon ?? startDetachedDaemon)();
  const client = await waitForHealthyClient(
    createClient,
    options.timeoutMs ?? 5000,
    deps.sleep ?? defaultSleep,
  );
  if (client === null) {
    throw new EnvdError(
      `cannot ${options.action}: daemon did not become healthy within ${options.timeoutMs ?? 5000}ms`,
      { code: "daemon_unreachable" },
    );
  }
  return { client, daemon: "started" };
}

async function ensureMount(
  options: CliPreflightOptions,
  deps: CliPreflightDeps,
): Promise<CliPreflightResult["mount"]> {
  if (options.ensureMount !== true) {
    return { checked: false };
  }

  const path = (deps.mountPath ?? mountPath)();
  const adapter = await (deps.createMountAdapter ?? createMountAdapter)();
  try {
    if (await adapter.isMounted(path)) {
      return { checked: true, path, mounted: true };
    }
    await adapter.mount((deps.webdavUrl ?? defaultWebdavUrl)(), path);
    return { checked: true, path, mounted: true };
  } catch (error: unknown) {
    throw new EnvdError(`cannot ${options.action}: failed to ensure mount`, {
      code: "mount_failed",
      cause: error,
      details: { path },
    });
  }
}

export async function ensureCliPreflight(
  options: CliPreflightOptions,
  deps: CliPreflightDeps = {},
): Promise<CliPreflightResult> {
  const daemon = await ensureDaemon(options, deps);
  const mount = await ensureMount(options, deps);
  return { ...daemon, mount };
}
