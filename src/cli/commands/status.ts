import { Command } from "commander";
import { lstatSync, readlinkSync } from "node:fs";
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
import { mountPath } from "../../shared/paths.js";
import type { MountAdapter } from "../../mount/adapter.js";
import { ENV_FILE } from "../project-files.js";
import {
  findProjectRegistration,
  migrateLegacyProjectFile,
  resolveProjectRoot,
} from "../config-file.js";

interface StatusOptions {
  readonly json?: boolean;
  readonly noAutostart?: boolean;
}

interface StatusDeps {
  readonly projectPath?: string;
  readonly client?: ControlClient;
  readonly createClient?: () => ControlClient;
  readonly mountAdapter?: MountAdapter;
  readonly createMountAdapter?: () => Promise<MountAdapter>;
}

export interface StatusResult {
  readonly daemon: {
    readonly running: boolean;
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

async function daemonStatus(client: ControlClient | null): Promise<{
  running: boolean;
  version: string | null;
  uptimeSec: number | null;
  error: string | null;
}> {
  if (client === null) {
    return {
      running: false,
      version: null,
      uptimeSec: null,
      error: "daemon unreachable",
    };
  }

  try {
    const health = await client.health();
    return {
      running: health.ok,
      version: health.version,
      uptimeSec: health.uptimeSec,
      error: null,
    };
  } catch (err: unknown) {
    return {
      running: false,
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

function printHuman(status: StatusResult): void {
  if (status.project === null) {
    process.stdout.write("project: not initialized\n");
    process.stdout.write("next: run envd init\n");
    if (!status.daemon.running) {
      process.stdout.write(`daemon: ${status.daemon.error ?? "not running"}\n`);
    }
    if (!status.mount.mounted) {
      process.stdout.write(`mount: ${status.mount.error ?? "not mounted"}\n`);
    }
    return;
  }

  process.stdout.write("project: initialized\n");
  process.stdout.write(`  id: ${status.project.projectId}\n`);
  process.stdout.write(
    `  active environment: ${status.project.activeEnvironment}\n`,
  );
  if (status.project.provider === null) {
    process.stdout.write("  provider: N/A\n");
    process.stdout.write("  provider health: N/A\n");
  } else {
    const providerLabel =
      status.project.provider.provider === null
        ? "(none)"
        : status.project.provider.name === null
          ? status.project.provider.provider
          : `${status.project.provider.provider} (${status.project.provider.name})`;
    process.stdout.write(`  provider: ${providerLabel}\n`);
    if (status.project.provider.healthy === true) {
      process.stdout.write("  provider health: ok\n");
    } else if (status.project.provider.error !== null) {
      process.stdout.write(
        `  provider health: error (${status.project.provider.error})\n`,
      );
    } else {
      process.stdout.write("  provider health: N/A\n");
    }
  }
  if (status.project.staging === null) {
    process.stdout.write("  staged: unavailable\n");
  } else {
    process.stdout.write(
      `  staged: +${status.project.staging.added} ~${status.project.staging.modified} -${status.project.staging.deleted}\n`,
    );
  }
  process.stdout.write(`  .env: ${status.project.linkState}\n`);
  process.stdout.write(
    `  last fetch: ${status.project.lastFetchTime ?? "N/A"}\n`,
  );
  process.stdout.write(`next: ${status.project.nextAction}\n`);

  if (!status.daemon.running) {
    process.stdout.write(`daemon: ${status.daemon.error ?? "not running"}\n`);
  }
  if (!status.mount.mounted) {
    process.stdout.write(`mount: ${status.mount.error ?? "not mounted"}\n`);
  }
}

export function buildStatusCommand(): Command {
  return new Command("status")
    .description("Show envd status")
    .option("--json", "JSON output")
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
          printHuman(status);
        }
      } catch (err: unknown) {
        writeCliError(err);
      }
    });
}
