import { Command } from "commander";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  ControlClient,
  ProjectDetail,
  ProjectStatusDetail,
} from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import { createMountAdapter } from "../../mount/index.js";
import { mountPath, pidFile, portsFile } from "../../shared/paths.js";
import type { MountAdapter } from "../../mount/adapter.js";
import { ENV_FILE } from "../project-files.js";
import {
  findProjectRegistration,
  migrateLegacyProjectFile,
  resolveProjectRoot,
} from "../config-file.js";

interface StatusOptions {
  readonly json?: boolean;
  readonly full?: boolean;
  readonly noAutostart?: boolean;
}

export interface StatusDeps {
  readonly projectPath?: string;
  readonly client?: ControlClient;
  readonly createClient?: () => ControlClient;
  readonly mountAdapter?: MountAdapter;
  readonly createMountAdapter?: () => Promise<MountAdapter>;
}

export interface StatusResult {
  readonly daemon: {
    readonly running: boolean;
    readonly pid: number | null;
    readonly ports: {
      readonly control: number;
      readonly webdav: number;
    } | null;
    readonly version: string | null;
    readonly uptimeSec: number | null;
    readonly error: string | null;
  };
  readonly mount: {
    readonly path: string | null;
    readonly mounted: boolean;
    readonly error: string | null;
  };
  readonly project: {
    readonly path: string;
    readonly projectId: string;
    readonly activeEnvironment: string;
    readonly envPath: string;
    readonly symlinkTarget: string | null;
    readonly linkState: "linked" | "stale" | "missing";
    readonly registered: boolean;
    readonly mountPath: string | null;
    readonly format: string | null;
    readonly provider: {
      readonly instanceId: string | null;
      readonly provider: string | null;
      readonly name: string | null;
      readonly healthy: boolean | null;
      readonly error: string | null;
    } | null;
    readonly staging: {
      readonly added: number;
      readonly modified: number;
      readonly deleted: number;
      readonly total: number;
    } | null;
    readonly lastFetchTime: string | null;
    readonly nextAction: string;
  } | null;
}

function readSymlinkTarget(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) {
      return null;
    }
    return readlinkSync(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function resolveClient(deps: StatusDeps): ControlClient | null {
  if (deps.client !== undefined) {
    return deps.client;
  }

  try {
    return (deps.createClient ?? createControlClient)();
  } catch (err: unknown) {
    if (err instanceof EnvdError && err.code === "daemon_unreachable") {
      return null;
    }
    throw err;
  }
}

function readPid(): number | null {
  try {
    const value = Number.parseInt(readFileSync(pidFile(), "utf-8"), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readPorts(): {
  readonly control: number;
  readonly webdav: number;
} | null {
  try {
    const parsed = JSON.parse(readFileSync(portsFile(), "utf-8")) as Record<
      string,
      unknown
    >;
    const control = parsed["control"];
    const webdav = parsed["webdav"];
    if (typeof control !== "number" || typeof webdav !== "number") {
      return null;
    }
    return { control, webdav };
  } catch {
    return null;
  }
}

async function daemonStatus(client: ControlClient | null): Promise<{
  running: boolean;
  pid: number | null;
  ports: {
    readonly control: number;
    readonly webdav: number;
  } | null;
  version: string | null;
  uptimeSec: number | null;
  error: string | null;
}> {
  const pid = readPid();
  const ports = readPorts();
  if (client === null) {
    return {
      running: false,
      pid,
      ports,
      version: null,
      uptimeSec: null,
      error: "daemon unreachable",
    };
  }

  try {
    const health = await client.health();
    return {
      running: health.ok,
      pid,
      ports,
      version: health.version,
      uptimeSec: health.uptimeSec,
      error: null,
    };
  } catch (err: unknown) {
    return {
      running: false,
      pid,
      ports,
      version: null,
      uptimeSec: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function mountStatus(deps: StatusDeps): Promise<{
  path: string | null;
  mounted: boolean;
  error: string | null;
}> {
  let path: string;
  try {
    path = mountPath();
  } catch (err: unknown) {
    return {
      path: null,
      mounted: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const adapter =
      deps.mountAdapter ??
      (await (deps.createMountAdapter ?? createMountAdapter)());
    return {
      path,
      mounted: await adapter.isMounted(path),
      error: null,
    };
  } catch (err: unknown) {
    return {
      path,
      mounted: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function projectStatus(
  projectDir: string,
  client: ControlClient | null,
): Promise<StatusResult["project"]> {
  migrateLegacyProjectFile(projectDir);
  const registration = findProjectRegistration(projectDir);
  if (registration === null) {
    return null;
  }

  const envPath = join(projectDir, ENV_FILE);
  const symlinkTarget = readSymlinkTarget(envPath);
  let project: ProjectDetail | null = null;
  let details: ProjectStatusDetail | null = null;

  if (client !== null) {
    try {
      project = await client.getProject(registration.id);
      details = await client.getProjectStatus(registration.id);
    } catch (err: unknown) {
      if (!(err instanceof EnvdError && err.code === "not_found")) {
        throw err;
      }
    }
  }
  const mountPathValue = project?.mountPath ?? null;
  const linkState =
    symlinkTarget === null
      ? "missing"
      : mountPathValue !== null && symlinkTarget === mountPathValue
        ? "linked"
        : "stale";
  const staging = details?.staging ?? null;
  const providerHealthy = details?.providerHealthy ?? null;
  const nextAction =
    providerHealthy === false
      ? "run envd provider test"
      : linkState !== "linked"
        ? "run envd link"
        : staging !== null && staging.total > 0
          ? "review with envd diff, then envd commit"
          : "no action needed";

  return {
    path: projectDir,
    projectId: registration.id,
    activeEnvironment:
      project?.activeEnvironment ?? registration.activeEnvironment,
    envPath,
    symlinkTarget,
    linkState,
    registered: project !== null,
    mountPath: mountPathValue,
    format: project?.format ?? null,
    provider:
      details === null
        ? null
        : {
            instanceId: details.providerInstanceId,
            provider: details.provider,
            name: details.providerInstanceName,
            healthy: details.providerHealthy,
            error: details.providerError,
          },
    staging,
    lastFetchTime:
      details?.lastFetchTime === null || details === null
        ? null
        : new Date(details.lastFetchTime).toISOString(),
    nextAction,
  };
}

export async function getStatus(deps: StatusDeps = {}): Promise<StatusResult> {
  const projectDir = resolveProjectRoot(deps.projectPath);
  const client = resolveClient(deps);
  const [daemon, mount, project] = await Promise.all([
    daemonStatus(client),
    mountStatus(deps),
    projectStatus(projectDir, client),
  ]);

  return { daemon, mount, project };
}

export function formatStatusHuman(status: StatusResult, full = false): string {
  const lines: string[] = [];
  if (full) {
    lines.push(`daemon: ${status.daemon.running ? "running" : "not running"}`);
    lines.push(`  pid: ${status.daemon.pid ?? "N/A"}`);
    lines.push(`  version: ${status.daemon.version ?? "N/A"}`);
    lines.push(`  uptime: ${status.daemon.uptimeSec ?? "N/A"}s`);
    lines.push(
      `  ports: ${
        status.daemon.ports === null
          ? "N/A"
          : `control=${status.daemon.ports.control}, webdav=${status.daemon.ports.webdav}`
      }`,
    );
    if (status.daemon.error !== null) {
      lines.push(`  error: ${status.daemon.error}`);
    }
    lines.push(`mount: ${status.mount.mounted ? "mounted" : "not mounted"}`);
    lines.push(`  path: ${status.mount.path ?? "N/A"}`);
    if (status.mount.error !== null) {
      lines.push(`  error: ${status.mount.error}`);
    }
  }

  if (status.project === null) {
    lines.push("project: not initialized");
    lines.push("next: run envd init");
    if (!status.daemon.running) {
      lines.push(`daemon: ${status.daemon.error ?? "not running"}`);
    }
    if (!status.mount.mounted) {
      lines.push(`mount: ${status.mount.error ?? "not mounted"}`);
    }
    return `${lines.join("\n")}\n`;
  }

  lines.push("project: initialized");
  lines.push(`  id: ${status.project.projectId}`);
  if (full) {
    lines.push(`  path: ${status.project.path}`);
    lines.push(`  registered: ${status.project.registered ? "yes" : "no"}`);
    lines.push(`  format: ${status.project.format ?? "N/A"}`);
    lines.push(`  mount path: ${status.project.mountPath ?? "N/A"}`);
    lines.push(`  env path: ${status.project.envPath}`);
    lines.push(
      `  symlink target: ${status.project.symlinkTarget ?? "missing"}`,
    );
  }
  lines.push(`  active environment: ${status.project.activeEnvironment}`);
  if (status.project.provider === null) {
    lines.push("  provider: N/A");
    lines.push("  provider health: N/A");
  } else {
    const providerLabel =
      status.project.provider.provider === null
        ? "(none)"
        : status.project.provider.name === null
          ? status.project.provider.provider
          : `${status.project.provider.provider} (${status.project.provider.name})`;
    lines.push(`  provider: ${providerLabel}`);
    if (full) {
      lines.push(
        `  provider instance: ${status.project.provider.instanceId ?? "N/A"}`,
      );
    }
    if (status.project.provider.healthy === true) {
      lines.push("  provider health: ok");
    } else if (status.project.provider.error !== null) {
      lines.push(`  provider health: error (${status.project.provider.error})`);
    } else {
      lines.push("  provider health: N/A");
    }
  }
  if (status.project.staging === null) {
    lines.push("  staged: unavailable");
  } else {
    lines.push(
      `  staged: +${status.project.staging.added} ~${status.project.staging.modified} -${status.project.staging.deleted}`,
    );
  }
  lines.push(`  .env: ${status.project.linkState}`);
  lines.push(`  last fetch: ${status.project.lastFetchTime ?? "N/A"}`);
  lines.push(`next: ${status.project.nextAction}`);

  if (!status.daemon.running) {
    lines.push(`daemon: ${status.daemon.error ?? "not running"}`);
  }
  if (!status.mount.mounted) {
    lines.push(`mount: ${status.mount.error ?? "not mounted"}`);
  }
  return `${lines.join("\n")}\n`;
}

function printHuman(status: StatusResult, full: boolean): void {
  process.stdout.write(formatStatusHuman(status, full));
}

export function buildStatusCommand(): Command {
  return new Command("status")
    .description("Show envd status")
    .option("--json", "JSON output")
    .option("--full", "include daemon, mount, and registration diagnostics")
    .option("--no-autostart", "fail instead of starting daemon support")
    .action(async (opts: StatusOptions) => {
      try {
        const preflight = await ensureCliPreflight({
          action: "show status",
          noAutostart: opts.noAutostart,
        });
        const status = await getStatus({ client: preflight.client });
        if (opts.json === true) {
          process.stdout.write(JSON.stringify(status) + "\n");
        } else {
          printHuman(status, opts.full === true);
        }
      } catch (err: unknown) {
        writeCliError(err);
      }
    });
}
