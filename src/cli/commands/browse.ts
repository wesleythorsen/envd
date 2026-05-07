import { Command } from "commander";
import type {
  ControlClient,
  ProjectEnvironmentValuesOptions,
  ProjectEnvironmentValuesResult,
} from "../../ipc/control-client.js";
import { readProjectEnvironmentValues } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import {
  findProjectRegistration,
  readEnvdConfig,
  resolveProjectRoot,
} from "../config-file.js";

interface Writable {
  write(chunk: string): unknown;
}

interface BrowseOptions {
  readonly reveal?: boolean;
  readonly path?: string;
  readonly json?: boolean;
  readonly noAutostart?: boolean;
}

type ReadEnvironmentFn = (
  projectId: string,
  opts?: ProjectEnvironmentValuesOptions,
) => Promise<ProjectEnvironmentValuesResult>;

interface BrowseDeps {
  readonly client?: Pick<ControlClient, "listProjectEnvironments">;
  readonly readEnvironment?: ReadEnvironmentFn;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

export type BrowseResult =
  | {
      readonly scope: "config";
      readonly providerInstances: ReturnType<
        typeof readEnvdConfig
      >["providerInstances"];
      readonly projects: ReturnType<typeof readEnvdConfig>["projects"];
    }
  | {
      readonly scope: "project";
      readonly projectId: string;
      readonly activeEnvironment: string;
      readonly environments: readonly {
        readonly name: string;
        readonly providerEnvironment: string;
        readonly keyCount: number;
      }[];
    }
  | {
      readonly scope: "environment";
      readonly projectId: string;
      readonly environment: string;
      readonly revealed: boolean;
      readonly keys: readonly {
        readonly name: string;
        readonly value?: string;
      }[];
    };

async function projectBrowse(
  environment: string | undefined,
  options: BrowseOptions,
  deps: BrowseDeps,
): Promise<BrowseResult> {
  const projectDir = resolveProjectRoot(options.path);
  const registration = findProjectRegistration(projectDir);
  if (registration === null) {
    const config = readEnvdConfig();
    return {
      scope: "config",
      providerInstances: config.providerInstances,
      projects: config.projects,
    };
  }

  const readEnvironment = deps.readEnvironment ?? readProjectEnvironmentValues;

  if (environment !== undefined) {
    const values = await readEnvironment(registration.id, { environment });
    return {
      scope: "environment",
      projectId: registration.id,
      environment: values.environment,
      revealed: options.reveal === true,
      keys: Object.entries(values.values)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => ({
          name,
          ...(options.reveal === true ? { value } : {}),
        })),
    };
  }

  const client = deps.client;
  if (client === undefined) {
    throw new EnvdError("browse project requires a running daemon", {
      code: "daemon_unreachable",
    });
  }
  const environments = await client.listProjectEnvironments(registration.id);
  const summaries = await Promise.all(
    environments.map(async (projectEnvironment) => {
      const values = await readEnvironment(registration.id, {
        environment: projectEnvironment.name,
      });
      return {
        name: projectEnvironment.name,
        providerEnvironment: projectEnvironment.providerEnvironment,
        keyCount: Object.keys(values.values).length,
      };
    }),
  );

  return {
    scope: "project",
    projectId: registration.id,
    activeEnvironment: registration.activeEnvironment,
    environments: summaries,
  };
}

export async function browse(
  environment: string | undefined,
  options: BrowseOptions = {},
  deps: BrowseDeps = {},
): Promise<BrowseResult> {
  return projectBrowse(environment, options, deps);
}

export function formatBrowseHuman(result: BrowseResult): string {
  const lines: string[] = [];
  if (result.scope === "config") {
    lines.push("Provider instances:");
    for (const provider of result.providerInstances) {
      lines.push(`  ${provider.name} (${provider.provider}) ${provider.id}`);
    }
    if (result.providerInstances.length === 0) {
      lines.push("  none");
    }
    lines.push("Projects:");
    for (const project of result.projects) {
      lines.push(
        `  ${project.root} ${project.id} active=${project.activeEnvironment}`,
      );
    }
    if (result.projects.length === 0) {
      lines.push("  none");
    }
    return `${lines.join("\n")}\n`;
  }

  if (result.scope === "project") {
    lines.push(`Project: ${result.projectId}`);
    lines.push(`Active environment: ${result.activeEnvironment}`);
    lines.push("Environments:");
    for (const environment of result.environments) {
      lines.push(
        `  ${environment.name} keys=${environment.keyCount} provider=${environment.providerEnvironment}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  lines.push(`Environment: ${result.environment}`);
  lines.push(result.revealed ? "Values: revealed" : "Values: hidden");
  for (const key of result.keys) {
    lines.push(`  ${key.name}${result.revealed ? `=${key.value ?? ""}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function writeResult(
  result: BrowseResult,
  options: BrowseOptions,
  deps: BrowseDeps,
): void {
  (deps.stdout ?? process.stdout).write(
    options.json === true
      ? `${JSON.stringify(result)}\n`
      : formatBrowseHuman(result),
  );
}

function handleBrowseError(error: unknown, deps: BrowseDeps): void {
  writeCliError(error, deps);
}

export function buildBrowseCommand(deps: BrowseDeps = {}): Command {
  return new Command("browse")
    .description("Browse envd projects, environments, and keys")
    .argument("[environment]", "environment to inspect")
    .option("--reveal", "include secret values")
    .option("--path <path>", "project directory")
    .option("--json", "JSON output")
    .option("--no-autostart", "fail instead of starting daemon support")
    .action(async (environment: string | undefined, opts: BrowseOptions) => {
      try {
        const projectDir = resolveProjectRoot(opts.path);
        const registration = findProjectRegistration(projectDir);
        const commandDeps =
          registration === null ||
          deps.client !== undefined ||
          deps.readEnvironment !== undefined
            ? deps
            : {
                ...deps,
                client: (
                  await ensureCliPreflight({
                    action: "browse secrets",
                    noAutostart: opts.noAutostart,
                  })
                ).client,
              };
        writeResult(await browse(environment, opts, commandDeps), opts, deps);
      } catch (error: unknown) {
        handleBrowseError(error, deps);
      }
    });
}
