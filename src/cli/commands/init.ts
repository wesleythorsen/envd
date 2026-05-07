import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  ControlClient,
  CreateProjectResult,
  ProviderInstanceDetail,
  ProviderMetadata,
  ProjectDetail,
} from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { parse as parseDotenv } from "../../core/rendering/dotenv.js";
import type { SecretMap } from "../../providers/base.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import { createMountAdapter } from "../../mount/index.js";
import { mountPath, portsFile } from "../../shared/paths.js";
import { stateDir } from "../../shared/paths.js";
import type { MountAdapter } from "../../mount/adapter.js";
import { addProviderInstance, type ProviderCommandDeps } from "./provider.js";
import {
  ENV_FILE,
  ensureEnvSymlink,
  ensureGitignore,
  isEnvdSymlink,
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
  type ExplicitEnvFileMapping,
  type EnvFileDiscoveryResult,
} from "../env-file-discovery.js";

interface InitOptions {
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly providerInstance?: string;
  readonly provider?: string;
  readonly newProvider?: boolean;
  readonly providerType?: string;
  readonly providerName?: string;
  readonly providerInstanceName?: string;
  readonly configJson?: string;
  readonly credentialsJson?: string;
  readonly noAutostart?: boolean;
  readonly scan?: readonly string[];
  readonly envFile?: readonly string[];
  readonly active?: string;
  readonly deleteImportedFiles?: boolean;
}

interface InitProjectDeps {
  readonly client: ControlClient;
  readonly mountAdapter?: MountAdapter;
  readonly ensureMount?: boolean;
  readonly confirm?: (plan: InitAdoptionPlan) => Promise<boolean>;
  readonly prompt?: NonNullable<ProviderCommandDeps["prompt"]>;
  readonly promptSecret?: ProviderCommandDeps["promptSecret"];
}

export interface InitResult {
  readonly status: "initialized" | "already_initialized";
  readonly projectId: string;
  readonly envPath: string;
  readonly symlinkTarget: string;
  readonly envFiles: EnvFileDiscoveryResult;
  readonly adoptionPlan: InitAdoptionPlan;
}

export interface InitProviderTarget {
  readonly kind: "existing" | "new";
  readonly id?: string;
  readonly provider?: string;
  readonly name?: string;
}

export interface InitAdoptionPlanFile {
  readonly path: string;
  readonly relativePath: string;
  readonly environment: string;
  readonly inferredEnvironment: string;
  readonly keyCount: number;
  readonly keys: readonly string[];
  readonly ambiguous: boolean;
  readonly duplicateKeys: readonly string[];
}

export interface InitAdoptionPlan {
  readonly projectRoot: string;
  readonly activeEnvironment: string;
  readonly providerTarget: InitProviderTarget;
  readonly sourceFileDisposition: "leave-in-place";
  readonly files: readonly InitAdoptionPlanFile[];
  readonly parseErrors: EnvFileDiscoveryResult["parseErrors"];
  readonly duplicateMappings: EnvFileDiscoveryResult["duplicates"];
}

interface PlanFileInput {
  readonly path: string;
  readonly relativePath: string;
  readonly inferredEnvironment: string;
  readonly environment: string;
  readonly keyCount: number;
  readonly keys: readonly string[];
  readonly ambiguous: boolean;
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

function parseEnvFileMapping(raw: string): ExplicitEnvFileMapping {
  const separator = raw.indexOf("=");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new EnvdError("--env-file must use <env>=<path>", {
      code: "usage_error",
    });
  }
  const environment = raw.slice(0, separator).trim();
  const path = raw.slice(separator + 1).trim();
  if (environment === "" || path === "") {
    throw new EnvdError("--env-file must use non-empty env and path values", {
      code: "usage_error",
    });
  }
  return { environment, path };
}

function uniqueSorted(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort();
}

function ensureGitignoreLine(projectDir: string, line: string): void {
  const path = join(projectDir, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, "utf-8");
    return;
  }
  const raw = readFileSync(path, "utf-8");
  const hasLine = raw
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === line);
  if (!hasLine) {
    const prefix = raw === "" || raw.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${raw}${prefix}${line}\n`, "utf-8");
  }
}

async function ensureMounted(adapter: MountAdapter): Promise<void> {
  const path = mountPath();
  if (await adapter.isMounted(path)) {
    return;
  }
  await adapter.mount(readWebdavUrl(), path);
}

async function promptConfirm(plan: InitAdoptionPlan): Promise<boolean> {
  const answer = await defaultPrompt(
    `Apply this envd init plan for ${plan.projectRoot}? [y/N]`,
  );
  return answer.trim().toLowerCase() === "y";
}

function duplicateKeysForFiles(
  files: readonly PlanFileInput[],
): Map<string, readonly string[]> {
  const byEnvironment = new Map<string, PlanFileInput[]>();
  for (const file of files) {
    const existing = byEnvironment.get(file.environment);
    if (existing === undefined) {
      byEnvironment.set(file.environment, [file]);
    } else {
      existing.push(file);
    }
  }

  const byPath = new Map<string, readonly string[]>();
  for (const environmentFiles of byEnvironment.values()) {
    const counts = new Map<string, number>();
    for (const file of environmentFiles) {
      for (const key of file.keys) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const duplicated = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key)
      .sort();
    for (const file of environmentFiles) {
      byPath.set(
        file.path,
        file.keys.filter((key) => duplicated.includes(key)),
      );
    }
  }
  return byPath;
}

function defaultActiveEnvironment(files: readonly PlanFileInput[]): string {
  return (
    files.find((file) => file.environment === "default")?.environment ??
    files[0]?.environment ??
    "default"
  );
}

function buildAdoptionPlan(
  projectRoot: string,
  envFiles: EnvFileDiscoveryResult,
  providerTarget: InitProviderTarget,
  overrides: {
    readonly environments?: ReadonlyMap<string, string>;
    readonly activeEnvironment?: string;
  } = {},
): InitAdoptionPlan {
  const files: readonly PlanFileInput[] = envFiles.files.map((file) => ({
    path: file.path,
    relativePath: file.relativePath,
    inferredEnvironment: file.classification.environment,
    environment:
      overrides.environments?.get(file.path) ?? file.classification.environment,
    keyCount: file.keyCount,
    keys: file.keys,
    ambiguous: file.classification.ambiguous,
  }));
  const duplicateKeys = duplicateKeysForFiles(files);
  const activeEnvironment =
    overrides.activeEnvironment ?? defaultActiveEnvironment(files);

  return {
    projectRoot,
    activeEnvironment,
    providerTarget,
    sourceFileDisposition: "leave-in-place",
    files: files.map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      environment: file.environment,
      inferredEnvironment: file.inferredEnvironment,
      keyCount: file.keyCount,
      keys: file.keys,
      ambiguous:
        file.ambiguous || file.environment !== file.inferredEnvironment,
      duplicateKeys: duplicateKeys.get(file.path) ?? [],
    })),
    parseErrors: envFiles.parseErrors,
    duplicateMappings: envFiles.duplicates,
  };
}

function providerTargetLabel(target: InitProviderTarget): string {
  if (target.kind === "existing") {
    return `${target.name ?? target.id ?? "existing provider instance"} (${target.provider ?? "provider"})`;
  }
  return `${target.name ?? target.provider ?? "new provider instance"} (${target.provider ?? "provider"})`;
}

function formatAdoptionPlan(plan: InitAdoptionPlan): string {
  const lines = [
    `envd init plan for ${plan.projectRoot}`,
    `Provider target: ${providerTargetLabel(plan.providerTarget)}`,
    `Active environment: ${plan.activeEnvironment}`,
    `Source files: ${plan.sourceFileDisposition}`,
  ];

  if (plan.files.length === 0) {
    lines.push("Env files: none discovered");
  } else {
    lines.push("Env files:");
    for (const file of plan.files) {
      const flags = [
        file.ambiguous ? "ambiguous" : "",
        file.duplicateKeys.length > 0
          ? `duplicate keys: ${file.duplicateKeys.join(", ")}`
          : "",
      ].filter((flag) => flag !== "");
      const suffix = flags.length === 0 ? "" : ` (${flags.join("; ")})`;
      lines.push(
        `- ${file.relativePath} -> ${file.environment} (${file.keyCount} keys)${suffix}`,
      );
    }
  }

  if (plan.parseErrors.length > 0) {
    lines.push("Parse errors:");
    for (const err of plan.parseErrors) {
      lines.push(`- ${err.relativePath}: ${err.message}`);
    }
  }

  if (plan.duplicateMappings.length > 0) {
    lines.push("Duplicate environment mappings:");
    for (const mapping of plan.duplicateMappings) {
      lines.push(
        `- ${mapping.environment}: ${mapping.conflictingKeys.length} conflicting keys`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function validateNonInteractivePlan(plan: InitAdoptionPlan): void {
  if (plan.parseErrors.length > 0) {
    throw new EnvdError("env file discovery found parse errors", {
      code: "bad_dotenv",
      details: { files: plan.parseErrors.map((err) => err.relativePath) },
    });
  }

  const conflicting = plan.duplicateMappings.filter(
    (mapping) => mapping.conflictingKeys.length > 0,
  );
  if (conflicting.length > 0) {
    throw new EnvdError(
      "multiple env files map to the same environment with conflicting values",
      {
        code: "usage_error",
        details: {
          environments: conflicting.map((mapping) => mapping.environment),
        },
      },
    );
  }

  const ambiguous = plan.files.filter((file) => file.ambiguous);
  if (ambiguous.length > 0) {
    throw new EnvdError("env file mappings are ambiguous", {
      code: "usage_error",
      details: { files: ambiguous.map((file) => file.relativePath) },
    });
  }
}

async function promptPlanEdits(
  plan: InitAdoptionPlan,
  envFiles: EnvFileDiscoveryResult,
  prompt: NonNullable<ProviderCommandDeps["prompt"]>,
): Promise<InitAdoptionPlan> {
  const environmentOverrides = new Map<string, string>();
  for (const file of plan.files) {
    const answer = await prompt(`Environment for ${file.relativePath}`, {
      defaultValue: file.environment,
    });
    const environment = answer.trim() === "" ? file.environment : answer.trim();
    if (environment === "") {
      throw new EnvdError("environment name must be non-empty", {
        code: "usage_error",
      });
    }
    environmentOverrides.set(file.path, environment);
  }

  const activeAnswer = await prompt("Active environment", {
    defaultValue: plan.activeEnvironment,
  });
  const activeEnvironment =
    activeAnswer.trim() === "" ? plan.activeEnvironment : activeAnswer.trim();
  if (activeEnvironment === "") {
    throw new EnvdError("active environment must be non-empty", {
      code: "usage_error",
    });
  }

  return buildAdoptionPlan(plan.projectRoot, envFiles, plan.providerTarget, {
    environments: environmentOverrides,
    activeEnvironment,
  });
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
  adoptionPlan: InitAdoptionPlan,
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
  ensureProjectEnvSymlink(projectDir, project.mountPath, adoptionPlan);

  return {
    status: "already_initialized",
    projectId: project.id,
    envPath: join(projectDir, ENV_FILE),
    symlinkTarget: project.mountPath,
    envFiles,
    adoptionPlan,
  };
}

function planEnvironmentNames(plan: InitAdoptionPlan): readonly string[] {
  return uniqueSorted([
    "default",
    plan.activeEnvironment,
    ...plan.files.map((file) => file.environment),
  ]);
}

function ensureProjectEnvSymlink(
  projectDir: string,
  target: string,
  plan: InitAdoptionPlan,
): void {
  const envPath = join(projectDir, ENV_FILE);
  if (
    existsSync(envPath) &&
    !isEnvdSymlink(envPath) &&
    plan.files.some((file) => file.relativePath === ENV_FILE)
  ) {
    return;
  }
  ensureEnvSymlink(projectDir, target);
}

function importedValuesByEnvironment(
  plan: InitAdoptionPlan,
): Map<string, SecretMap> {
  const valuesByEnvironment = new Map<string, SecretMap>();
  for (const file of plan.files) {
    const parsed = parseDotenv(readFileSync(file.path));
    const existing = valuesByEnvironment.get(file.environment) ?? {};
    valuesByEnvironment.set(file.environment, { ...existing, ...parsed });
  }
  return valuesByEnvironment;
}

async function importAdoptionPlan(
  client: ControlClient,
  projectId: string,
  plan: InitAdoptionPlan,
): Promise<void> {
  for (const [environment, values] of importedValuesByEnvironment(plan)) {
    await client.importProjectEnvironment(projectId, { environment, values });
  }
}

function retiredDirName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function retiredPathFor(
  root: string,
  retiredRoot: string,
  source: string,
): string {
  const relativePath = source.startsWith(root)
    ? source.slice(root.length + 1)
    : basename(source);
  return join(retiredRoot, relativePath);
}

function retireImportedFiles(
  projectDir: string,
  plan: InitAdoptionPlan,
  deleteImportedFiles: boolean,
): void {
  if (plan.files.length === 0) {
    return;
  }

  ensureGitignoreLine(projectDir, ".envd-retired/");
  const retiredRoot = join(projectDir, ".envd-retired", retiredDirName());
  if (!deleteImportedFiles) {
    mkdirSync(retiredRoot, { recursive: true });
  }

  const receipt = {
    timestamp: new Date().toISOString(),
    projectRoot: projectDir,
    providerTarget: plan.providerTarget,
    activeEnvironment: plan.activeEnvironment,
    undoCommand: "envd eject --from-retired",
    disposition: deleteImportedFiles ? "deleted" : "retired",
    files: plan.files.map((file) => {
      const retiredPath = retiredPathFor(projectDir, retiredRoot, file.path);
      return {
        originalPath: file.path,
        retiredPath,
        environment: file.environment,
        keyCount: file.keyCount,
      };
    }),
  };

  for (const file of plan.files) {
    if (deleteImportedFiles) {
      unlinkSync(file.path);
      continue;
    }
    const retiredPath = retiredPathFor(projectDir, retiredRoot, file.path);
    mkdirSync(dirname(retiredPath), { recursive: true });
    renameSync(file.path, retiredPath);
  }

  if (!deleteImportedFiles) {
    writeFileSync(
      join(retiredRoot, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf-8",
    );
  }
}

async function newProjectResult(
  client: ControlClient,
  projectDir: string,
  providerInstanceId: string,
  envFiles: EnvFileDiscoveryResult,
  adoptionPlan: InitAdoptionPlan,
  options: InitOptions,
): Promise<InitResult> {
  const created: CreateProjectResult = await client.createProject({
    path: projectDir,
    providerInstanceId,
  });
  const environments = planEnvironmentNames(adoptionPlan);
  for (const environment of environments) {
    if (environment !== "default") {
      await client.createProjectEnvironment(created.id, {
        name: environment,
        providerEnvironment: environment,
      });
    }
  }
  if (adoptionPlan.activeEnvironment !== "default") {
    await client.setProjectActiveEnvironment(
      created.id,
      adoptionPlan.activeEnvironment,
    );
  }
  await importAdoptionPlan(client, created.id, adoptionPlan);
  retireImportedFiles(
    projectDir,
    adoptionPlan,
    options.deleteImportedFiles === true,
  );
  registerProject({
    id: created.id,
    root: projectDir,
    providerInstanceId,
    activeEnvironment: adoptionPlan.activeEnvironment,
    environments: environments.map((environment) => ({
      name: environment,
      providerEnvironment: environment,
    })),
  });
  ensureGitignore(projectDir);
  ensureProjectEnvSymlink(projectDir, created.mountPath, adoptionPlan);

  return {
    status: "initialized",
    projectId: created.id,
    envPath: join(projectDir, ENV_FILE),
    symlinkTarget: created.mountPath,
    envFiles,
    adoptionPlan,
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
  if (options.providerName !== undefined) {
    addOptions.name = requireNonEmptyFlag(
      options.providerName,
      "--provider-name",
    );
  } else if (options.providerInstanceName !== undefined) {
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
    options.newProvider === true ||
    options.providerType !== undefined ||
    options.providerName !== undefined ||
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
  selectedProviderName?: string,
): Promise<string> {
  const prompt = deps.prompt ?? defaultPrompt;
  const providerName =
    selectedProviderName ??
    (options.provider === undefined
      ? await promptProviderName(await deps.client.listProviders(), prompt)
      : requireNonEmptyFlag(options.provider, "--provider"));
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

async function providerInstanceTarget(
  deps: InitProjectDeps,
  id: string,
): Promise<InitProviderTarget> {
  try {
    const instance = await deps.client.getProviderInstance(id);
    return {
      kind: "existing",
      id: instance.id,
      provider: instance.provider,
      name: instance.name,
    };
  } catch {
    return { kind: "existing", id };
  }
}

function newProviderTarget(
  provider: string,
  name: string | undefined,
): InitProviderTarget {
  return name === undefined
    ? { kind: "new", provider }
    : { kind: "new", provider, name };
}

function defaultPersonalProviderPath(): string {
  return join(stateDir(), "providers", "personal");
}

function isDefaultPersonalLocalTarget(target: InitProviderTarget): boolean {
  return (
    target.kind === "new" &&
    target.provider === "envd" &&
    target.name === "personal"
  );
}

async function providerInstanceTargetByName(
  options: InitOptions,
  deps: InitProjectDeps,
): Promise<InitProviderTarget> {
  const providerName = requireNonEmptyFlag(
    options.provider ?? "",
    "--provider",
  );
  const instances = await deps.client.listProviderInstances();
  const instance = instances.find(
    (candidate) =>
      candidate.name === providerName || candidate.id === providerName,
  );
  if (instance === undefined) {
    throw new EnvdError("provider instance was not found", {
      code: "usage_error",
      details: { provider: providerName },
    });
  }
  return {
    kind: "existing",
    id: instance.id,
    provider: instance.provider,
    name: instance.name,
  };
}

function validateNewProviderFlags(options: InitOptions): void {
  if (options.newProvider !== true) {
    if (
      options.providerType !== undefined ||
      options.providerName !== undefined
    ) {
      throw new EnvdError(
        "--provider-type and --provider-name require --new-provider",
        { code: "usage_error" },
      );
    }
    return;
  }

  if (options.provider !== undefined) {
    throw new EnvdError("--provider cannot be combined with --new-provider", {
      code: "usage_error",
    });
  }
  if (options.providerType !== undefined) {
    requireNonEmptyFlag(options.providerType, "--provider-type");
  }
  if (options.providerName !== undefined) {
    requireNonEmptyFlag(options.providerName, "--provider-name");
  }
}

async function selectProviderTarget(
  options: InitOptions,
  deps: InitProjectDeps,
): Promise<InitProviderTarget> {
  validateProviderInstanceFlags(options);
  validateNewProviderFlags(options);
  if (options.providerInstance !== undefined) {
    return providerInstanceTarget(deps, options.providerInstance);
  }

  if (options.newProvider === true) {
    const provider =
      options.providerType === undefined
        ? await promptProviderName(
            await deps.client.listProviders(),
            deps.prompt ?? defaultPrompt,
          )
        : requireNonEmptyFlag(options.providerType, "--provider-type");
    return newProviderTarget(provider, options.providerName);
  }

  if (options.provider !== undefined) {
    return providerInstanceTargetByName(options, deps);
  }

  const instances = await deps.client.listProviderInstances();
  if (instances.length === 0) {
    return newProviderTarget("envd", "personal");
  }

  const choice = await promptProviderInstanceChoice(
    instances,
    deps.prompt ?? defaultPrompt,
  );
  if (choice.kind === "existing") {
    return providerInstanceTarget(deps, choice.id);
  }
  return newProviderTarget(
    await promptProviderName(
      await deps.client.listProviders(),
      deps.prompt ?? defaultPrompt,
    ),
    options.providerName ?? options.providerInstanceName,
  );
}

async function materializeProviderTarget(
  target: InitProviderTarget,
  options: InitOptions,
  deps: InitProjectDeps,
): Promise<string> {
  if (target.kind === "existing") {
    if (target.id === undefined) {
      throw new EnvdError("provider instance target is missing an id", {
        code: "internal",
      });
    }
    return target.id;
  }
  if (target.provider === undefined) {
    throw new EnvdError("provider target is missing a provider type", {
      code: "internal",
    });
  }
  if (
    isDefaultPersonalLocalTarget(target) &&
    options.configJson === undefined &&
    options.credentialsJson === undefined
  ) {
    const path = defaultPersonalProviderPath();
    mkdirSync(dirname(path), { recursive: true });
    const created = await deps.client.createProviderInstance({
      provider: "envd",
      name: "personal",
      config: { root: path },
      credentials: {},
    });
    return created.id;
  }
  return createProviderInstanceForInit(options, deps, target.provider);
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

  const envFiles = discoverEnvFiles(projectDir, {
    scanPaths: options.scan ?? [],
    envFiles: (options.envFile ?? []).map(parseEnvFileMapping),
  });
  let registration = findProjectRegistration(projectDir);
  const providerTarget =
    registration?.providerInstanceId === undefined
      ? await selectProviderTarget(options, deps)
      : await providerInstanceTarget(deps, registration.providerInstanceId);
  const activeEnvironment =
    options.active === undefined
      ? undefined
      : requireNonEmptyFlag(options.active, "--active");
  let adoptionPlan = buildAdoptionPlan(
    projectDir,
    envFiles,
    providerTarget,
    activeEnvironment === undefined ? {} : { activeEnvironment },
  );

  if (options.yes === true) {
    validateNonInteractivePlan(adoptionPlan);
  } else {
    output.write(formatAdoptionPlan(adoptionPlan));
    adoptionPlan = await promptPlanEdits(
      adoptionPlan,
      envFiles,
      deps.prompt ?? defaultPrompt,
    );
    output.write(formatAdoptionPlan(adoptionPlan));
    const confirm = deps.confirm ?? promptConfirm;
    if (!(await confirm(adoptionPlan))) {
      throw new EnvdError("initialization cancelled", { code: "usage_error" });
    }
  }

  if (deps.ensureMount !== false) {
    const adapter = deps.mountAdapter ?? (await createMountAdapter());
    await ensureMounted(adapter);
  }

  if (registration === null) {
    migrateLegacyProjectFile(projectDir);
    registration = findProjectRegistration(projectDir);
  }
  if (registration !== null) {
    return existingProjectResult(
      deps.client,
      projectDir,
      registration,
      envFiles,
      adoptionPlan,
    );
  }

  const providerInstanceId = await materializeProviderTarget(
    adoptionPlan.providerTarget,
    options,
    deps,
  );
  return newProjectResult(
    deps.client,
    projectDir,
    providerInstanceId,
    envFiles,
    adoptionPlan,
    options,
  );
}

export function buildInitCommand(): Command {
  return new Command("init")
    .description("Initialize envd in a project directory")
    .argument("[path]", "project directory")
    .option("--yes", "skip confirmation prompt")
    .option(
      "--env-file <env=path>",
      "explicit env file mapping",
      collectOption,
      [],
    )
    .option("--active <env>", "active environment after init")
    .option("--provider-instance <id>", "provider instance id to use")
    .option("--provider <name>", "existing provider instance/org name or id")
    .option("--new-provider", "create a provider instance during init")
    .option("--provider-type <type>", "provider type for --new-provider")
    .option(
      "--provider-name <name>",
      "provider instance/org name for --new-provider",
    )
    .option(
      "--provider-instance-name <name>",
      "deprecated alias for --provider-name",
    )
    .option("--config-json <json>", "provider config JSON for auto-create")
    .option(
      "--credentials-json <json>",
      "provider credentials JSON for auto-create",
    )
    .option("--json", "JSON output")
    .option("--scan <path>", "additional env file scan path", collectOption, [])
    .option(
      "--delete-imported-files",
      "delete imported env files after provider import verification",
    )
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
