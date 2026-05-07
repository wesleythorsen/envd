import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ControlClient,
  CreateProjectResult,
  ProviderInstanceDetail,
  ProviderMetadata,
  ProjectDetail,
} from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import { createMountAdapter } from "../../mount/index.js";
import { mountPath, portsFile } from "../../shared/paths.js";
import type { MountAdapter } from "../../mount/adapter.js";
import { addProviderInstance, type ProviderCommandDeps } from "./provider.js";
import {
  ENV_FILE,
  ensureEnvSymlink,
  ensureGitignore,
} from "../project-files.js";
import {
  findProjectRegistration,
  migrateLegacyProjectFile,
  registerProject,
  resolveProjectRoot,
  type ProjectRegistration,
} from "../config-file.js";
import {
  discoverEnvFiles,
  type EnvFileDiscoveryResult,
} from "../env-file-discovery.js";

interface InitOptions {
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly providerInstance?: string;
  readonly provider?: string;
  readonly providerInstanceName?: string;
  readonly configJson?: string;
  readonly credentialsJson?: string;
  readonly noAutostart?: boolean;
  readonly scan?: readonly string[];
}

interface InitProjectDeps {
  readonly client: ControlClient;
  readonly mountAdapter?: MountAdapter;
  readonly ensureMount?: boolean;
  readonly confirm?: (projectPath: string) => Promise<boolean>;
  readonly prompt?: NonNullable<ProviderCommandDeps["prompt"]>;
  readonly promptSecret?: ProviderCommandDeps["promptSecret"];
}

export interface InitResult {
  readonly status: "initialized" | "already_initialized";
  readonly projectId: string;
  readonly envPath: string;
  readonly symlinkTarget: string;
  readonly envFiles: EnvFileDiscoveryResult;
}

function readWebdavUrl(): string {
  // as-cast justified: ports.json is a daemon-owned serialization boundary.
  const ports = JSON.parse(readFileSync(portsFile(), "utf-8")) as Record<
    string,
    unknown
  >;
  const webdav = ports["webdav"];
  if (typeof webdav !== "number") {
    throw new EnvdError("ports file is missing webdav port", {
      code: "daemon_unreachable",
    });
  }
  return `http://127.0.0.1:${webdav}/`;
}

function defaultPrompt(
  question: string,
  opts?: { readonly defaultValue?: string },
): Promise<string> {
  const suffix =
    opts?.defaultValue === undefined ? "" : ` [${opts.defaultValue}]`;
  const rl = createInterface({ input, output });
  return rl.question(`${question}${suffix}: `).finally(() => {
    rl.close();
  });
}

function collectOption(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

async function ensureMounted(adapter: MountAdapter): Promise<void> {
  const path = mountPath();
  if (await adapter.isMounted(path)) {
    return;
  }
  await adapter.mount(readWebdavUrl(), path);
}

async function promptConfirm(projectPath: string): Promise<boolean> {
  const answer = await defaultPrompt(
    `Initialize envd in ${projectPath}? [y/N]`,
  );
  return answer.trim().toLowerCase() === "y";
}

function printResult(result: InitResult, json: boolean | undefined): void {
  if (json === true) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  if (result.status === "already_initialized") {
    process.stdout.write(`envd already initialized (${result.projectId})\n`);
  } else {
    process.stdout.write(`envd initialized (${result.projectId})\n`);
  }
}

async function existingProjectResult(
  client: ControlClient,
  projectDir: string,
  registration: ProjectRegistration,
  envFiles: EnvFileDiscoveryResult,
): Promise<InitResult> {
  let project: ProjectDetail;
  try {
    project = await client.getProject(registration.id);
  } catch (err: unknown) {
    if (err instanceof EnvdError && err.code === "not_found") {
      throw new EnvdError(
        "this project is not registered on this machine; run envd init again",
        { code: "not_initialized" },
      );
    }
    throw err;
  }

  ensureGitignore(projectDir);
  ensureEnvSymlink(projectDir, project.mountPath);

  return {
    status: "already_initialized",
    projectId: project.id,
    envPath: join(projectDir, ENV_FILE),
    symlinkTarget: project.mountPath,
    envFiles,
  };
}

async function newProjectResult(
  client: ControlClient,
  projectDir: string,
  providerInstanceId: string,
  envFiles: EnvFileDiscoveryResult,
): Promise<InitResult> {
  const created: CreateProjectResult = await client.createProject({
    path: projectDir,
    providerInstanceId,
  });
  registerProject({
    id: created.id,
    root: projectDir,
    providerInstanceId,
    activeEnvironment: "default",
    environments: [{ name: "default", providerEnvironment: "default" }],
  });
  ensureGitignore(projectDir);
  ensureEnvSymlink(projectDir, created.mountPath);

  return {
    status: "initialized",
    projectId: created.id,
    envPath: join(projectDir, ENV_FILE),
    symlinkTarget: created.mountPath,
    envFiles,
  };
}

function requireNonEmptyFlag(value: string, flag: string): string {
  if (value.trim() === "") {
    throw new EnvdError(`${flag} must be non-empty`, {
      code: "usage_error",
    });
  }
  return value;
}

function providerChoiceFromAnswer(
  answer: string,
  providers: readonly ProviderMetadata[],
): string | undefined {
  const trimmed = answer.trim();
  if (trimmed === "") {
    return providers.length === 1 ? providers[0]?.name : undefined;
  }

  const index = Number.parseInt(trimmed, 10);
  if (String(index) === trimmed && index >= 1 && index <= providers.length) {
    return providers[index - 1]?.name;
  }

  return providers.find((provider) => provider.name === trimmed)?.name;
}

async function promptProviderName(
  providers: readonly ProviderMetadata[],
  prompt: NonNullable<ProviderCommandDeps["prompt"]>,
): Promise<string> {
  if (providers.length === 0) {
    throw new EnvdError("no providers are registered", {
      code: "usage_error",
    });
  }

  if (providers.length === 1) {
    const onlyProvider = providers[0];
    if (onlyProvider === undefined) {
      throw new EnvdError("no providers are registered", {
        code: "usage_error",
      });
    }
    for (;;) {
      const answer = await prompt("Provider", {
        defaultValue: onlyProvider.name,
      });
      const provider = providerChoiceFromAnswer(answer, providers);
      if (provider !== undefined) {
        return provider;
      }
      output.write(`Unknown provider: ${answer.trim()}\n`);
    }
  }

  const choices = providers
    .map((provider, index) => `${index + 1}) ${provider.name}`)
    .join("\n");
  for (;;) {
    const answer = await prompt(`Choose provider:\n${choices}\nSelection`, {
      defaultValue: "1",
    });
    const provider = providerChoiceFromAnswer(answer, providers);
    if (provider !== undefined) {
      return provider;
    }
    output.write(`Unknown provider: ${answer.trim()}\n`);
  }
}

function instanceChoiceFromAnswer(
  answer: string,
  instances: readonly ProviderInstanceDetail[],
):
  | { readonly kind: "existing"; readonly id: string }
  | { readonly kind: "new" }
  | undefined {
  const trimmed = answer.trim();
  if (trimmed === "" && instances.length > 0) {
    const first = instances[0];
    return first === undefined ? undefined : { kind: "existing", id: first.id };
  }

  if (["new", "create", "+"].includes(trimmed.toLowerCase())) {
    return { kind: "new" };
  }

  const index = Number.parseInt(trimmed, 10);
  if (String(index) === trimmed) {
    if (index >= 1 && index <= instances.length) {
      const instance = instances[index - 1];
      return instance === undefined
        ? undefined
        : { kind: "existing", id: instance.id };
    }
    if (index === instances.length + 1) {
      return { kind: "new" };
    }
  }

  const instance = instances.find((candidate) => candidate.id === trimmed);
  return instance === undefined
    ? undefined
    : { kind: "existing", id: instance.id };
}

async function promptProviderInstanceChoice(
  instances: readonly ProviderInstanceDetail[],
  prompt: NonNullable<ProviderCommandDeps["prompt"]>,
): Promise<
  { readonly kind: "existing"; readonly id: string } | { readonly kind: "new" }
> {
  const choices = instances
    .map(
      (instance, index) =>
        `${index + 1}) ${instance.name} (${instance.provider}, ${instance.id})`,
    )
    .concat(`${instances.length + 1}) Create new`)
    .join("\n");

  for (;;) {
    const answer = await prompt(
      `Choose provider instance:\n${choices}\nSelection`,
      { defaultValue: "1" },
    );
    const choice = instanceChoiceFromAnswer(answer, instances);
    if (choice !== undefined) {
      return choice;
    }
    output.write(`Unknown provider instance: ${answer.trim()}\n`);
  }
}

function providerAddOptions(
  options: InitOptions,
  defaultName?: string,
): {
  readonly name?: string;
  readonly configJson?: string;
  readonly credentialsJson?: string;
} {
  const addOptions: {
    name?: string;
    configJson?: string;
    credentialsJson?: string;
  } = {};
  if (options.providerInstanceName !== undefined) {
    addOptions.name = requireNonEmptyFlag(
      options.providerInstanceName,
      "--provider-instance-name",
    );
  } else if (defaultName !== undefined) {
    addOptions.name = defaultName;
  }
  if (options.configJson !== undefined) {
    addOptions.configJson = options.configJson;
  }
  if (options.credentialsJson !== undefined) {
    addOptions.credentialsJson = options.credentialsJson;
  }
  return addOptions;
}

function validateProviderInstanceFlags(options: InitOptions): void {
  if (options.providerInstance === undefined) {
    return;
  }

  requireNonEmptyFlag(options.providerInstance, "--provider-instance");
  if (
    options.provider !== undefined ||
    options.providerInstanceName !== undefined ||
    options.configJson !== undefined ||
    options.credentialsJson !== undefined
  ) {
    throw new EnvdError(
      "--provider-instance cannot be combined with provider creation flags",
      { code: "usage_error" },
    );
  }
}

async function createProviderInstanceForInit(
  options: InitOptions,
  deps: InitProjectDeps,
): Promise<string> {
  const prompt = deps.prompt ?? defaultPrompt;
  const providerName =
    options.provider === undefined
      ? await promptProviderName(await deps.client.listProviders(), prompt)
      : requireNonEmptyFlag(options.provider, "--provider");
  const created = await addProviderInstance(
    providerName,
    providerAddOptions(
      options,
      options.provider === undefined ? undefined : providerName,
    ),
    deps.promptSecret === undefined
      ? {
          client: deps.client,
          prompt,
        }
      : {
          client: deps.client,
          prompt,
          promptSecret: deps.promptSecret,
        },
  );
  return created.id;
}

async function selectProviderInstanceId(
  options: InitOptions,
  deps: InitProjectDeps,
): Promise<string> {
  validateProviderInstanceFlags(options);
  if (options.providerInstance !== undefined) {
    return options.providerInstance;
  }

  if (options.provider !== undefined) {
    return createProviderInstanceForInit(options, deps);
  }

  const instances = await deps.client.listProviderInstances();
  if (instances.length === 0) {
    return createProviderInstanceForInit(options, deps);
  }

  const choice = await promptProviderInstanceChoice(
    instances,
    deps.prompt ?? defaultPrompt,
  );
  if (choice.kind === "existing") {
    return choice.id;
  }
  return createProviderInstanceForInit(options, deps);
}

export async function initProject(
  projectPath: string | undefined,
  options: InitOptions,
  deps: InitProjectDeps,
): Promise<InitResult> {
  const projectDir = resolveProjectRoot(projectPath);
  if (!existsSync(projectDir)) {
    throw new EnvdError("project path does not exist", {
      code: "usage_error",
      details: { path: projectDir },
    });
  }

  if (options.yes !== true) {
    const confirm = deps.confirm ?? promptConfirm;
    if (!(await confirm(projectDir))) {
      throw new EnvdError("initialization cancelled", { code: "usage_error" });
    }
  }

  if (deps.ensureMount !== false) {
    const adapter = deps.mountAdapter ?? (await createMountAdapter());
    await ensureMounted(adapter);
  }

  migrateLegacyProjectFile(projectDir);
  const envFiles = discoverEnvFiles(projectDir, {
    scanPaths: options.scan ?? [],
  });
  const registration = findProjectRegistration(projectDir);
  if (registration !== null) {
    return existingProjectResult(
      deps.client,
      projectDir,
      registration,
      envFiles,
    );
  }

  const providerInstanceId = await selectProviderInstanceId(options, deps);
  return newProjectResult(
    deps.client,
    projectDir,
    providerInstanceId,
    envFiles,
  );
}

export function buildInitCommand(): Command {
  return new Command("init")
    .description("Initialize envd in a project directory")
    .argument("[path]", "project directory")
    .option("--yes", "skip confirmation prompt")
    .option("--provider-instance <id>", "provider instance id to use")
    .option("--provider <name>", "provider name to create and use")
    .option(
      "--provider-instance-name <name>",
      "display name when creating a provider instance",
    )
    .option("--config-json <json>", "provider config JSON for auto-create")
    .option(
      "--credentials-json <json>",
      "provider credentials JSON for auto-create",
    )
    .option("--json", "JSON output")
    .option("--scan <path>", "additional env file scan path", collectOption, [])
    .option("--no-autostart", "fail instead of starting daemon/mount support")
    .action(async (path: string | undefined, opts: InitOptions) => {
      try {
        const preflight = await ensureCliPreflight({
          action: "initialize project",
          ensureMount: true,
          noAutostart: opts.noAutostart,
        });
        const result = await initProject(path, opts, {
          client: preflight.client,
          ensureMount: false,
        });
        printResult(result, opts.json);
      } catch (err: unknown) {
        writeCliError(err);
      }
    });
}
