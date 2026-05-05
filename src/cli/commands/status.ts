import { Command } from "commander";
import { lstatSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ControlClient,
  ProjectDetail,
  ProjectStatusDetail,
} from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { createMountAdapter } from "../../mount/index.js";
import { mountPath } from "../../shared/paths.js";
import type { MountAdapter } from "../../mount/adapter.js";
import { ENV_FILE, readProjectFile } from "../project-files.js";

interface StatusOptions {
  readonly json?: boolean;
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
    readonly envPath: string;
    readonly symlinkTarget: string | null;
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
  const projectFile = readProjectFile(projectDir);
  if (projectFile === null) {
    return null;
  }

  const envPath = join(projectDir, ENV_FILE);
  const symlinkTarget = readSymlinkTarget(envPath);
  let project: ProjectDetail | null = null;
  let details: ProjectStatusDetail | null = null;

  if (client !== null) {
    try {
      project = await client.getProject(projectFile.projectId);
      details = await client.getProjectStatus(projectFile.projectId);
    } catch (err: unknown) {
      if (!(err instanceof EnvdError && err.code === "not_found")) {
        throw err;
      }
    }
  }

  return {
    path: projectDir,
    projectId: projectFile.projectId,
    envPath,
    symlinkTarget,
    registered: project !== null,
    mountPath: project?.mountPath ?? null,
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
    staging: details?.staging ?? null,
    lastFetchTime:
      details?.lastFetchTime === null || details === null
        ? null
        : new Date(details.lastFetchTime).toISOString(),
  };
}

export async function getStatus(deps: StatusDeps = {}): Promise<StatusResult> {
  const projectDir = resolve(deps.projectPath ?? process.cwd());
  const client = resolveClient(deps);
  const [daemon, mount, project] = await Promise.all([
    daemonStatus(client),
    mountStatus(deps),
    projectStatus(projectDir, client),
  ]);

  return { daemon, mount, project };
}

function printHuman(status: StatusResult): void {
  process.stdout.write(
    `daemon: ${status.daemon.running ? "running" : "not running"}\n`,
  );
  if (status.daemon.version !== null) {
    process.stdout.write(`  version: ${status.daemon.version}\n`);
  }
  if (status.daemon.uptimeSec !== null) {
    process.stdout.write(`  uptime: ${status.daemon.uptimeSec}s\n`);
  }

  process.stdout.write(
    `mount: ${status.mount.mounted ? "mounted" : "not mounted"}\n`,
  );
  if (status.mount.path !== null) {
    process.stdout.write(`  path: ${status.mount.path}\n`);
  }
  if (status.mount.error !== null) {
    process.stdout.write(`  error: ${status.mount.error}\n`);
  }

  if (status.project === null) {
    process.stdout.write("project: not initialized\n");
    return;
  }

  process.stdout.write("project: initialized\n");
  process.stdout.write(`  id: ${status.project.projectId}\n`);
  process.stdout.write(
    `  registered: ${status.project.registered ? "yes" : "no"}\n`,
  );
  if (status.project.format !== null) {
    process.stdout.write(`  format: ${status.project.format}\n`);
  }
  if (status.project.mountPath !== null) {
    process.stdout.write(`  mount path: ${status.project.mountPath}\n`);
  }
  process.stdout.write(
    `  symlink: ${status.project.symlinkTarget ?? "(missing)"}\n`,
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
  process.stdout.write(
    `  last fetch: ${status.project.lastFetchTime ?? "N/A"}\n`,
  );
}

export function buildStatusCommand(): Command {
  return new Command("status")
    .description("Show envd status")
    .option("--json", "JSON output")
    .action(async (opts: StatusOptions) => {
      try {
        const status = await getStatus();
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
