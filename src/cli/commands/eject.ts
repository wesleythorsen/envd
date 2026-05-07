import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultStdout } from "node:process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ControlClient,
  ProjectEnvironmentValuesOptions,
  ProjectEnvironmentValuesResult,
} from "../../ipc/control-client.js";
import { readProjectEnvironmentValues } from "../../ipc/control-client.js";
import { render as renderDotenv } from "../../core/rendering/dotenv.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import { ENV_FILE, isEnvdSymlink, removeEnvSymlink } from "../project-files.js";
import {
  removeProjectRegistration,
  resolveProjectRegistrationOrThrow,
  resolveProjectRoot,
  type ProjectRegistration,
} from "../config-file.js";

interface Writable {
  write(chunk: string): unknown;
}

interface EjectOptions {
  readonly fromRetired?: boolean;
  readonly purge?: boolean;
  readonly yes?: boolean;
  readonly path?: string;
  readonly json?: boolean;
  readonly noAutostart?: boolean;
}

type ConfirmFn = (question: string) => Promise<boolean>;

type ReadEnvironmentFn = (
  projectId: string,
  opts?: ProjectEnvironmentValuesOptions,
) => Promise<ProjectEnvironmentValuesResult>;

interface EjectCommandDeps {
  readonly client?: Pick<ControlClient, "deleteProject">;
  readonly readEnvironment?: ReadEnvironmentFn;
  readonly confirm?: ConfirmFn;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

interface RetiredReceiptFile {
  readonly originalPath: string;
  readonly retiredPath: string;
  readonly environment: string;
  readonly keyCount: number;
}

interface RetiredReceipt {
  readonly files: readonly RetiredReceiptFile[];
}

export interface EjectFilePlan {
  readonly environment: string;
  readonly path: string;
  readonly source: "provider" | "retired";
}

export interface EjectResult {
  readonly status: "ejected";
  readonly projectId: string;
  readonly files: readonly EjectFilePlan[];
  readonly removedRegistration: boolean;
  readonly removedSymlink: boolean;
  readonly purged: boolean;
}

function out(deps: EjectCommandDeps, text: string): void {
  (deps.stdout ?? defaultStdout).write(text);
}

function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: defaultInput, output: defaultStdout });
  return rl
    .question(`${question} [y/N]: `)
    .finally(() => {
      rl.close();
    })
    .then((answer) => {
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    });
}

function envFileForEnvironment(
  projectDir: string,
  environment: string,
): string {
  return environment === "default"
    ? join(projectDir, ENV_FILE)
    : join(projectDir, `${ENV_FILE}.${environment}`);
}

function assertWritableTarget(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() && isEnvdSymlink(path)) {
    return;
  }
  throw new EnvdError(`refusing to overwrite existing file: ${path}`, {
    code: "usage_error",
    details: { path },
  });
}

function latestRetiredReceipt(projectDir: string): RetiredReceipt {
  const retiredRoot = join(projectDir, ".envd-retired");
  if (!existsSync(retiredRoot)) {
    throw new EnvdError("no retired env files receipt found", {
      code: "not_found",
      details: { path: retiredRoot },
    });
  }
  const candidates = readdirSync(retiredRoot)
    .map((entry) => join(retiredRoot, entry, "receipt.json"))
    .filter((path) => existsSync(path))
    .sort();
  const receiptPath = candidates[candidates.length - 1];
  if (receiptPath === undefined) {
    throw new EnvdError("no retired env files receipt found", {
      code: "not_found",
      details: { path: retiredRoot },
    });
  }

  const parsed = JSON.parse(readFileSync(receiptPath, "utf-8")) as unknown;
  if (parsed === null || typeof parsed !== "object") {
    throw new EnvdError("retired env receipt is malformed", {
      code: "usage_error",
      details: { path: receiptPath },
    });
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    throw new EnvdError("retired env receipt is missing files", {
      code: "usage_error",
      details: { path: receiptPath },
    });
  }

  return {
    files: files.map((file): RetiredReceiptFile => {
      if (file === null || typeof file !== "object") {
        throw new EnvdError("retired env receipt file entry is malformed", {
          code: "usage_error",
          details: { path: receiptPath },
        });
      }
      const record = file as Record<string, unknown>;
      const originalPath = record["originalPath"];
      const retiredPath = record["retiredPath"];
      const environment = record["environment"];
      const keyCount = record["keyCount"];
      if (
        typeof originalPath !== "string" ||
        typeof retiredPath !== "string" ||
        typeof environment !== "string" ||
        typeof keyCount !== "number"
      ) {
        throw new EnvdError("retired env receipt file entry is malformed", {
          code: "usage_error",
          details: { path: receiptPath },
        });
      }
      return { originalPath, retiredPath, environment, keyCount };
    }),
  };
}

async function providerPlan(
  projectDir: string,
  registration: ProjectRegistration,
  readEnvironment: ReadEnvironmentFn,
): Promise<{
  readonly files: readonly EjectFilePlan[];
  readonly write: () => void;
}> {
  const rendered = await Promise.all(
    registration.environments.map(async (environment) => {
      const values = await readEnvironment(registration.id, {
        environment: environment.name,
        includeStaging: false,
      });
      return {
        environment: environment.name,
        path: envFileForEnvironment(projectDir, environment.name),
        values: values.values,
      };
    }),
  );

  return {
    files: rendered.map((file) => ({
      environment: file.environment,
      path: file.path,
      source: "provider" as const,
    })),
    write() {
      for (const file of rendered) {
        assertWritableTarget(file.path);
      }
      removeEnvSymlink(projectDir);
      for (const file of rendered) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, renderDotenv(file.values));
      }
    },
  };
}

function retiredPlan(projectDir: string): {
  readonly files: readonly EjectFilePlan[];
  readonly write: () => void;
} {
  const receipt = latestRetiredReceipt(projectDir);
  return {
    files: receipt.files.map((file) => ({
      environment: file.environment,
      path: file.originalPath,
      source: "retired" as const,
    })),
    write() {
      for (const file of receipt.files) {
        assertWritableTarget(file.originalPath);
      }
      removeEnvSymlink(projectDir);
      for (const file of receipt.files) {
        mkdirSync(dirname(file.originalPath), { recursive: true });
        copyFileSync(file.retiredPath, file.originalPath);
      }
    },
  };
}

async function confirmEject(
  plan: readonly EjectFilePlan[],
  options: EjectOptions,
  deps: EjectCommandDeps,
): Promise<void> {
  if (options.json === true) {
    return;
  }
  printPlan(plan, deps);
  if (options.yes === true) {
    return;
  }
  const accepted = await (deps.confirm ?? defaultConfirm)(
    "Remove envd management for this project?",
  );
  if (!accepted) {
    throw new EnvdError("eject cancelled", { code: "usage_error" });
  }
}

export async function ejectProject(
  options: EjectOptions,
  deps: EjectCommandDeps = {},
): Promise<EjectResult> {
  const projectDir = resolveProjectRoot(options.path);
  const registration = resolveProjectRegistrationOrThrow(options.path);
  const plan =
    options.fromRetired === true
      ? retiredPlan(projectDir)
      : await providerPlan(
          projectDir,
          registration,
          deps.readEnvironment ?? readProjectEnvironmentValues,
        );

  await confirmEject(plan.files, options, deps);
  plan.write();
  removeProjectRegistration(registration.id);

  if (options.purge === true) {
    await deps.client?.deleteProject(registration.id);
  }

  return {
    status: "ejected",
    projectId: registration.id,
    files: plan.files,
    removedRegistration: true,
    removedSymlink: true,
    purged: options.purge === true,
  };
}

function printPlan(
  files: readonly EjectFilePlan[],
  deps: EjectCommandDeps,
): void {
  out(deps, "envd eject will recreate:\n");
  for (const file of files) {
    out(deps, `  ${file.path} (${file.environment}, ${file.source})\n`);
  }
}

function printHumanResult(result: EjectResult, deps: EjectCommandDeps): void {
  out(
    deps,
    `envd ejected (files=${result.files.length}, purged=${String(result.purged)})\n`,
  );
}

function handleEjectError(errValue: unknown, deps: EjectCommandDeps): void {
  writeCliError(errValue, deps);
}

export function buildEjectCommand(deps: EjectCommandDeps = {}): Command {
  return new Command("eject")
    .description("Return a project to ordinary env files")
    .option("--from-retired", "restore exact pre-adoption env files")
    .option("--purge", "also remove the project from local envd state")
    .option("--yes", "skip confirmation")
    .option("--path <path>", "project directory")
    .option("--json", "JSON output")
    .option("--no-autostart", "fail instead of starting daemon support")
    .action(async (opts: EjectOptions) => {
      try {
        const commandDeps =
          deps.client !== undefined || deps.readEnvironment !== undefined
            ? deps
            : {
                ...deps,
                client: (
                  await ensureCliPreflight({
                    action: "eject project",
                    noAutostart: opts.noAutostart,
                  })
                ).client,
              };
        const result = await ejectProject(opts, commandDeps);
        if (opts.json === true) {
          out(deps, JSON.stringify(result) + "\n");
          return;
        }
        printHumanResult(result, deps);
      } catch (error: unknown) {
        handleEjectError(error, deps);
      }
    });
}
