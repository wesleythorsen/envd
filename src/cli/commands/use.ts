import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultStdout } from "node:process";
import { join } from "node:path";
import type {
  ControlClient,
  ProjectDetail,
  ProjectDiffResult,
  ProjectEnvironmentDetail,
} from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import { ENV_FILE, ensureEnvSymlink } from "../project-files.js";
import {
  registerProject,
  resolveProjectRegistrationOrThrow,
  resolveProjectRoot,
  type ProjectEnvironmentRegistration,
} from "../config-file.js";

interface Writable {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

type PromptFn = (
  question: string,
  opts?: { readonly defaultValue?: string },
) => Promise<string>;

interface UseOptions {
  readonly create?: boolean;
  readonly providerEnvironment?: string;
  readonly path?: string;
  readonly json?: boolean;
  readonly noAutostart?: boolean;
}

interface UseCommandDeps {
  readonly client?: ControlClient;
  readonly createClient?: () => ControlClient;
  readonly prompt?: PromptFn;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

export interface StagedSummary {
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  readonly total: number;
}

export interface UseResult {
  readonly status: "switched";
  readonly projectId: string;
  readonly previousEnvironment: string;
  readonly activeEnvironment: string;
  readonly envPath: string;
  readonly symlinkTarget: string;
  readonly staged: {
    readonly previous: StagedSummary;
    readonly active: StagedSummary;
  };
}

function resolveClient(deps: UseCommandDeps): ControlClient {
  if (deps.client !== undefined) {
    return deps.client;
  }
  return (deps.createClient ?? createControlClient)();
}

function out(deps: UseCommandDeps, text: string): void {
  (deps.stdout ?? defaultStdout).write(text);
}

function defaultPrompt(
  question: string,
  opts?: { readonly defaultValue?: string },
): Promise<string> {
  const suffix =
    opts?.defaultValue === undefined ? "" : ` [${opts.defaultValue}]`;
  const rl = createInterface({ input: defaultInput, output: defaultStdout });
  return rl.question(`${question}${suffix}: `).finally(() => {
    rl.close();
  });
}

function summarizeDiff(diff: ProjectDiffResult): StagedSummary {
  const added = diff.keys.added.length;
  const modified = diff.keys.modified.length;
  const deleted = diff.keys.deleted.length;
  return { added, modified, deleted, total: added + modified + deleted };
}

async function stagedSummaryForEnvironment(
  client: ControlClient,
  projectId: string,
  environment: string,
): Promise<StagedSummary> {
  return summarizeDiff(await client.getProjectDiff(projectId, { environment }));
}

function environmentRegistrations(
  environments: readonly ProjectEnvironmentDetail[],
): readonly ProjectEnvironmentRegistration[] {
  return environments.map((environment) => ({
    name: environment.name,
    providerEnvironment: environment.providerEnvironment,
  }));
}

function environmentExists(
  environments: readonly ProjectEnvironmentDetail[],
  name: string,
): boolean {
  return environments.some((environment) => environment.name === name);
}

async function selectEnvironment(
  environments: readonly ProjectEnvironmentDetail[],
  activeEnvironment: string,
  deps: UseCommandDeps,
): Promise<string> {
  if (environments.length === 0) {
    throw new EnvdError("project has no environments; run envd init", {
      code: "not_initialized",
    });
  }

  out(deps, "Select environment:\n");
  environments.forEach((environment, index) => {
    const marker = environment.name === activeEnvironment ? " *" : "";
    out(deps, `  ${index + 1}. ${environment.name}${marker}\n`);
  });

  const answer = (
    await (deps.prompt ?? defaultPrompt)("Environment", {
      defaultValue: activeEnvironment,
    })
  ).trim();
  if (answer === "") {
    return activeEnvironment;
  }

  const index = Number.parseInt(answer, 10);
  if (
    Number.isInteger(index) &&
    String(index) === answer &&
    index >= 1 &&
    index <= environments.length
  ) {
    return environments[index - 1]?.name ?? activeEnvironment;
  }

  if (environmentExists(environments, answer)) {
    return answer;
  }

  throw new EnvdError(`environment "${answer}" does not exist`, {
    code: "not_found",
  });
}

async function ensureTargetEnvironment(
  client: ControlClient,
  projectId: string,
  requestedEnvironment: string | undefined,
  activeEnvironment: string,
  environments: readonly ProjectEnvironmentDetail[],
  options: UseOptions,
  deps: UseCommandDeps,
): Promise<{
  readonly targetEnvironment: string;
  readonly environments: readonly ProjectEnvironmentDetail[];
}> {
  if (requestedEnvironment === undefined) {
    return {
      targetEnvironment: await selectEnvironment(
        environments,
        activeEnvironment,
        deps,
      ),
      environments,
    };
  }

  if (environmentExists(environments, requestedEnvironment)) {
    return { targetEnvironment: requestedEnvironment, environments };
  }

  if (options.create !== true) {
    throw new EnvdError(
      `environment "${requestedEnvironment}" does not exist; run envd use ${requestedEnvironment} --create to create it, or envd init if this project is not initialized`,
      { code: "not_found" },
    );
  }

  const created = await client.createProjectEnvironment(projectId, {
    name: requestedEnvironment,
    providerEnvironment: options.providerEnvironment ?? requestedEnvironment,
  });
  return {
    targetEnvironment: requestedEnvironment,
    environments: [...environments, created],
  };
}

export async function useEnvironment(
  requestedEnvironment: string | undefined,
  options: UseOptions,
  deps: UseCommandDeps,
): Promise<UseResult> {
  const projectPath = options.path;
  const projectDir = resolveProjectRoot(projectPath);
  const registration = resolveProjectRegistrationOrThrow(projectPath);
  const client = resolveClient(deps);
  const environments = await client.listProjectEnvironments(registration.id);
  const previousEnvironment = registration.activeEnvironment;
  const target = await ensureTargetEnvironment(
    client,
    registration.id,
    requestedEnvironment,
    previousEnvironment,
    environments,
    options,
    deps,
  );

  const previousSummary = await stagedSummaryForEnvironment(
    client,
    registration.id,
    previousEnvironment,
  );
  const activeSummary =
    target.targetEnvironment === previousEnvironment
      ? previousSummary
      : await stagedSummaryForEnvironment(
          client,
          registration.id,
          target.targetEnvironment,
        );

  const project: ProjectDetail = await client.setProjectActiveEnvironment(
    registration.id,
    target.targetEnvironment,
  );
  ensureEnvSymlink(projectDir, project.mountPath);

  registerProject({
    ...registration,
    activeEnvironment: target.targetEnvironment,
    environments: environmentRegistrations(target.environments),
  });

  return {
    status: "switched",
    projectId: registration.id,
    previousEnvironment,
    activeEnvironment: target.targetEnvironment,
    envPath: join(projectDir, ENV_FILE),
    symlinkTarget: project.mountPath,
    staged: {
      previous: previousSummary,
      active: activeSummary,
    },
  };
}

function formatSummary(summary: StagedSummary): string {
  return `+${summary.added} ~${summary.modified} -${summary.deleted}`;
}

function printHumanResult(result: UseResult, deps: UseCommandDeps): void {
  out(deps, `envd using ${result.activeEnvironment} (${result.projectId})\n`);

  const hasRelevantStaging =
    result.staged.previous.total > 0 || result.staged.active.total > 0;
  if (!hasRelevantStaging) {
    return;
  }

  out(deps, "Staged changes preserved:\n");
  out(
    deps,
    `  ${result.previousEnvironment}: ${formatSummary(result.staged.previous)}\n`,
  );
  if (result.activeEnvironment !== result.previousEnvironment) {
    out(
      deps,
      `  ${result.activeEnvironment}: ${formatSummary(result.staged.active)}\n`,
    );
  }
}

function handleUseError(errValue: unknown, deps: UseCommandDeps): void {
  writeCliError(errValue, deps);
}

export function buildUseCommand(deps: UseCommandDeps = {}): Command {
  return new Command("use")
    .description("Switch the active project environment")
    .argument("[environment]", "environment to activate")
    .option("--create", "create the environment when it does not exist")
    .option(
      "--provider-environment <name>",
      "provider-side environment/config name when creating",
    )
    .option("--path <path>", "project directory")
    .option("--json", "JSON output")
    .option("--no-autostart", "fail instead of starting daemon/mount support")
    .action(async (environment: string | undefined, opts: UseOptions) => {
      try {
        const commandDeps =
          deps.client !== undefined || deps.createClient !== undefined
            ? deps
            : {
                ...deps,
                client: (
                  await ensureCliPreflight({
                    action: "switch environment",
                    ensureMount: true,
                    noAutostart: opts.noAutostart,
                  })
                ).client,
              };
        const result = await useEnvironment(environment, opts, commandDeps);
        if (opts.json === true) {
          out(deps, JSON.stringify(result) + "\n");
          return;
        }
        printHumanResult(result, deps);
      } catch (error: unknown) {
        handleUseError(error, deps);
      }
    });
}
