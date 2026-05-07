import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { configFile } from "../shared/paths.js";
import { EnvdError } from "../shared/errors.js";
import {
  PROJECT_FILE,
  parseProjectFile,
  type ProjectFile,
} from "./project-files.js";

export interface ProviderInstanceRegistration {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
}

export interface ProjectEnvironmentRegistration {
  readonly name: string;
  readonly providerEnvironment: string;
}

export interface ProjectRegistration {
  readonly id: string;
  readonly root: string;
  readonly providerInstanceId?: string;
  readonly providerProject?: string;
  readonly activeEnvironment: string;
  readonly environments: readonly ProjectEnvironmentRegistration[];
}

export interface EnvdConfig {
  readonly schemaVersion: 1;
  readonly providerInstances: readonly ProviderInstanceRegistration[];
  readonly projects: readonly ProjectRegistration[];
}

interface ConfigEditDeps {
  readonly editor?: string;
  readonly runEditor?: (editor: string, path: string) => number;
}

const DEFAULT_ENVIRONMENT = "default";

function emptyConfig(): EnvdConfig {
  return { schemaVersion: 1, providerInstances: [], projects: [] };
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function parseTomlString(value: string, context: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    throw new EnvdError(`${context} must be a quoted string`, {
      code: "usage_error",
    });
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "string") {
      throw new Error("not a string");
    }
    return parsed;
  } catch (err: unknown) {
    throw new EnvdError(`${context} is not a valid TOML string`, {
      code: "usage_error",
      cause: err,
    });
  }
}

function parseTomlStringArray(
  value: string,
  context: string,
): readonly string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new EnvdError(`${context} must be a string array`, {
      code: "usage_error",
    });
  }

  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }

  return inner
    .split(",")
    .map((part, index) => parseTomlString(part.trim(), `${context}[${index}]`));
}

function requireString(
  record: Record<string, string>,
  key: string,
  context: string,
): string {
  const value = record[key];
  if (value === undefined || value.trim() === "") {
    throw new EnvdError(`${context}.${key} is required`, {
      code: "usage_error",
    });
  }
  return value;
}

function parseProjectEnvironment(
  envName: string,
  record: Record<string, string>,
): ProjectEnvironmentRegistration {
  return {
    name: envName,
    providerEnvironment: record["provider_environment"] ?? envName,
  };
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function hasGitDir(path: string): boolean {
  try {
    statSync(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

export function resolveProjectRoot(projectPath: string | undefined): string {
  let current = canonicalPath(projectPath ?? process.cwd());
  for (;;) {
    if (hasGitDir(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return canonicalPath(projectPath ?? process.cwd());
    }
    current = parent;
  }
}

export function serializeEnvdConfig(config: EnvdConfig): string {
  const lines: string[] = [
    "# envd machine-local config. Secrets are not stored in this file.",
    "schema_version = 1",
    "",
  ];

  for (const provider of config.providerInstances) {
    lines.push("[[provider_instances]]");
    lines.push(`id = ${quoteTomlString(provider.id)}`);
    lines.push(`name = ${quoteTomlString(provider.name)}`);
    lines.push(`provider = ${quoteTomlString(provider.provider)}`);
    lines.push("");
  }

  for (const project of config.projects) {
    lines.push("[[projects]]");
    lines.push(`id = ${quoteTomlString(project.id)}`);
    lines.push(`root = ${quoteTomlString(project.root)}`);
    if (project.providerInstanceId !== undefined) {
      lines.push(
        `provider_instance_id = ${quoteTomlString(project.providerInstanceId)}`,
      );
    }
    if (project.providerProject !== undefined) {
      lines.push(
        `provider_project = ${quoteTomlString(project.providerProject)}`,
      );
    }
    lines.push(
      `active_environment = ${quoteTomlString(project.activeEnvironment)}`,
    );
    lines.push(
      `environments = [${project.environments
        .map((env) => quoteTomlString(env.name))
        .join(", ")}]`,
    );
    for (const env of project.environments) {
      lines.push("");
      lines.push(
        `[projects.environment.${quoteTomlString(project.id)}.${quoteTomlString(env.name)}]`,
      );
      lines.push(
        `provider_environment = ${quoteTomlString(env.providerEnvironment)}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function parseEnvdConfig(raw: string): EnvdConfig {
  const providers: ProviderInstanceRegistration[] = [];
  const projects: ProjectRegistration[] = [];
  const projectEnvironmentRecords = new Map<string, Record<string, string>>();
  let schemaVersion: number | undefined;
  let current:
    | { readonly kind: "root" }
    | { readonly kind: "provider"; readonly record: Record<string, string> }
    | { readonly kind: "project"; readonly record: Record<string, string> }
    | { readonly kind: "environment"; readonly key: string };

  current = { kind: "root" };

  for (const [lineIndex, rawLine] of raw.split(/\r?\n/).entries()) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    const line = withoutComment.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    if (line === "[[provider_instances]]") {
      const record: Record<string, string> = {};
      providers.push(record as unknown as ProviderInstanceRegistration);
      current = { kind: "provider", record };
      continue;
    }

    if (line === "[[projects]]") {
      const record: Record<string, string> = {};
      projects.push(record as unknown as ProjectRegistration);
      current = { kind: "project", record };
      continue;
    }

    const environmentMatch = line.match(
      /^\[projects\.environment\.("[^"]+")\.("[^"]+")\]$/,
    );
    if (environmentMatch !== null) {
      const projectId = parseTomlString(
        environmentMatch[1] ?? "",
        `line ${lineIndex + 1} project id`,
      );
      const envName = parseTomlString(
        environmentMatch[2] ?? "",
        `line ${lineIndex + 1} environment name`,
      );
      const key = `${projectId}\0${envName}`;
      projectEnvironmentRecords.set(key, {});
      current = { kind: "environment", key };
      continue;
    }

    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (assignment === null) {
      throw new EnvdError(`config line ${lineIndex + 1} is not valid TOML`, {
        code: "usage_error",
      });
    }

    const key = assignment[1] ?? "";
    const value = assignment[2] ?? "";
    if (current.kind === "root") {
      if (key !== "schema_version") {
        throw new EnvdError(`unknown root config key: ${key}`, {
          code: "usage_error",
        });
      }
      schemaVersion = Number.parseInt(value, 10);
      continue;
    }

    if (current.kind === "environment") {
      const record = projectEnvironmentRecords.get(current.key);
      if (record === undefined) {
        throw new EnvdError("internal config parser error", {
          code: "internal",
        });
      }
      record[key] = parseTomlString(value, `line ${lineIndex + 1} ${key}`);
      continue;
    }

    if (key === "environments") {
      current.record[key] = JSON.stringify(
        parseTomlStringArray(value, `line ${lineIndex + 1} environments`),
      );
      continue;
    }
    current.record[key] = parseTomlString(
      value,
      `line ${lineIndex + 1} ${key}`,
    );
  }

  if (schemaVersion !== 1) {
    throw new EnvdError("config schema_version must be 1", {
      code: "usage_error",
    });
  }

  return {
    schemaVersion: 1,
    providerInstances: providers.map((rawProvider, index) => {
      const record = rawProvider as unknown as Record<string, string>;
      return {
        id: requireString(record, "id", `provider_instances[${index}]`),
        name: requireString(record, "name", `provider_instances[${index}]`),
        provider: requireString(
          record,
          "provider",
          `provider_instances[${index}]`,
        ),
      };
    }),
    projects: projects.map((rawProject, index) => {
      const record = rawProject as unknown as Record<string, string>;
      const id = requireString(record, "id", `projects[${index}]`);
      const root = canonicalPath(
        requireString(record, "root", `projects[${index}]`),
      );
      const activeEnvironment =
        record["active_environment"] ?? DEFAULT_ENVIRONMENT;
      const envNames =
        record["environments"] === undefined
          ? [activeEnvironment]
          : (JSON.parse(record["environments"]) as string[]);
      const environments = envNames.map((envName) =>
        parseProjectEnvironment(
          envName,
          projectEnvironmentRecords.get(`${id}\0${envName}`) ?? {},
        ),
      );
      const providerInstanceId = record["provider_instance_id"];
      const providerProject = record["provider_project"];
      return {
        id,
        root,
        ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
        ...(providerProject === undefined ? {} : { providerProject }),
        activeEnvironment,
        environments,
      };
    }),
  };
}

export function readEnvdConfig(path = configFile()): EnvdConfig {
  if (!existsSync(path)) {
    return emptyConfig();
  }
  return parseEnvdConfig(readFileSync(path, "utf-8"));
}

export function writeEnvdConfig(config: EnvdConfig, path = configFile()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeEnvdConfig(config), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function upsertProjectRegistration(
  config: EnvdConfig,
  registration: ProjectRegistration,
): EnvdConfig {
  return {
    ...config,
    projects: [
      ...config.projects.filter(
        (project) =>
          project.id !== registration.id && project.root !== registration.root,
      ),
      registration,
    ],
  };
}

export function removeProjectRegistration(
  projectId: string,
  path = configFile(),
): void {
  const config = readEnvdConfig(path);
  writeEnvdConfig(
    {
      ...config,
      projects: config.projects.filter((project) => project.id !== projectId),
    },
    path,
  );
}

export function findProjectRegistration(
  projectPath: string | undefined,
  config = readEnvdConfig(),
): ProjectRegistration | null {
  const root = resolveProjectRoot(projectPath);
  return config.projects.find((project) => project.root === root) ?? null;
}

export function resolveProjectRegistrationOrThrow(
  projectPath: string | undefined,
): ProjectRegistration {
  const root = resolveProjectRoot(projectPath);
  const config = readEnvdConfig();
  const registration =
    config.projects.find((project) => project.root === root) ?? null;
  if (registration !== null) {
    return registration;
  }

  const migrated = migrateLegacyProjectFile(root);
  if (migrated !== null) {
    const migratedRegistration = findProjectRegistration(root);
    if (migratedRegistration !== null) {
      return migratedRegistration;
    }
  }

  throw new EnvdError("project is not initialized; run envd init", {
    code: "not_initialized",
    details: { path: root },
  });
}

export function registerProject(
  registration: ProjectRegistration,
  path = configFile(),
): void {
  writeEnvdConfig(
    upsertProjectRegistration(readEnvdConfig(path), registration),
    path,
  );
}

export function migrateLegacyProjectFile(
  projectRoot: string,
  path = configFile(),
): (ProjectFile & { readonly retiredPath: string }) | null {
  const legacyPath = join(projectRoot, PROJECT_FILE);
  if (!existsSync(legacyPath)) {
    return null;
  }

  const projectFile = parseProjectFile(legacyPath);
  const config = readEnvdConfig(path);
  if (
    !config.projects.some((project) => project.id === projectFile.projectId)
  ) {
    writeEnvdConfig(
      upsertProjectRegistration(config, {
        id: projectFile.projectId,
        root: projectRoot,
        activeEnvironment: DEFAULT_ENVIRONMENT,
        environments: [
          {
            name: DEFAULT_ENVIRONMENT,
            providerEnvironment: DEFAULT_ENVIRONMENT,
          },
        ],
      }),
      path,
    );
  }

  const retiredPath = join(projectRoot, `${PROJECT_FILE}.retired`);
  if (!existsSync(retiredPath)) {
    renameSync(legacyPath, retiredPath);
  }
  return { ...projectFile, retiredPath };
}

export function editConfig(
  path = configFile(),
  deps: ConfigEditDeps = {},
): void {
  if (!existsSync(path)) {
    writeEnvdConfig(emptyConfig(), path);
  }

  const before = readFileSync(path, "utf-8");
  const editor =
    deps.editor ?? process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi";
  const status =
    deps.runEditor?.(editor, path) ??
    spawnSync(editor, [path], { stdio: "inherit" }).status ??
    1;
  if (status !== 0) {
    throw new EnvdError(`editor exited with status ${status}`, {
      code: "usage_error",
    });
  }

  try {
    parseEnvdConfig(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    writeFileSync(path, before, { encoding: "utf-8", mode: 0o600 });
    throw err;
  }
}
