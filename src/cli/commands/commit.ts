import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import {
  stdin as defaultInput,
  stdout as defaultStdout,
  stderr as defaultStderr,
} from "node:process";
import type {
  ControlClient,
  ProjectCommitResult,
  ProjectCommitStrategy,
  ProjectDiffResult,
} from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { errorHintForCode, writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import { formatDiff } from "./diff.js";
import { resolveProjectRegistrationOrThrow } from "../config-file.js";

interface Writable {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

type ConfirmFn = (question: string) => Promise<boolean>;

interface CommitOptions {
  readonly message?: string;
  readonly environment?: string;
  readonly theirs?: boolean;
  readonly ours?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly noAutostart?: boolean;
}

interface CommitCommandDeps {
  readonly client?: ControlClient;
  readonly createClient?: () => ControlClient;
  readonly confirm?: ConfirmFn;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

export interface CommitResult {
  readonly status: "committed";
  readonly projectId: string;
  readonly applied: ProjectCommitResult["applied"];
  readonly commitId: string | null;
}

function resolveClient(deps: CommitCommandDeps): ControlClient {
  if (deps.client !== undefined) {
    return deps.client;
  }
  return (deps.createClient ?? createControlClient)();
}

function out(deps: CommitCommandDeps, text: string): void {
  (deps.stdout ?? defaultStdout).write(text);
}

function err(deps: CommitCommandDeps, text: string): void {
  (deps.stderr ?? defaultStderr).write(text);
}

function resolveProjectId(projectPath: string | undefined): string {
  return resolveProjectRegistrationOrThrow(projectPath).id;
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

function hasDiff(diff: ProjectDiffResult): boolean {
  return (
    diff.keys.added.length > 0 ||
    diff.keys.modified.length > 0 ||
    diff.keys.deleted.length > 0
  );
}

function resolveStrategy(options: CommitOptions): ProjectCommitStrategy {
  if (options.theirs === true && options.ours === true) {
    throw new EnvdError("choose only one of --theirs or --ours", {
      code: "usage_error",
    });
  }
  if (options.theirs === true) {
    return "theirs";
  }
  if (options.ours === true) {
    return "ours";
  }
  return "abort";
}

async function confirmCommit(
  client: ControlClient,
  projectId: string,
  options: CommitOptions,
  deps: CommitCommandDeps,
): Promise<void> {
  if (options.yes === true || options.json === true) {
    return;
  }

  const diff = await client.getProjectDiff(projectId, {
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
  });
  if (!hasDiff(diff)) {
    return;
  }

  out(deps, "About to push these keys:\n");
  out(deps, formatDiff(diff, false, deps.stdout ?? defaultStdout));

  const confirm = deps.confirm ?? defaultConfirm;
  const accepted = await confirm("Commit these staged changes?");
  if (!accepted) {
    throw new EnvdError("commit cancelled", {
      code: "usage_error",
    });
  }
}

export async function commitProject(
  projectPath: string | undefined,
  options: CommitOptions,
  deps: CommitCommandDeps,
): Promise<CommitResult> {
  const projectId = resolveProjectId(projectPath);
  const strategy = resolveStrategy(options);
  const client = resolveClient(deps);

  await confirmCommit(client, projectId, options, deps);
  const commitOptions =
    options.message === undefined
      ? {
          strategy,
          ...(options.environment === undefined
            ? {}
            : { environment: options.environment }),
        }
      : {
          message: options.message,
          strategy,
          ...(options.environment === undefined
            ? {}
            : { environment: options.environment }),
        };
  const result = await client.commitProject(projectId, commitOptions);

  return {
    status: "committed",
    projectId,
    applied: result.applied,
    commitId: result.commitId,
  };
}

function printHumanResult(result: CommitResult, deps: CommitCommandDeps): void {
  const upsertCount = Object.keys(result.applied.upserts).length;
  const deleteCount = result.applied.deletes.length;
  out(
    deps,
    `envd committed (upserts=${upsertCount}, deletes=${deleteCount})\n`,
  );
}

function conflictKeysFromDetails(details: unknown): string[] {
  if (details === null || typeof details !== "object") {
    return [];
  }

  const detailRecord = details as Record<string, unknown>;
  const conflicts = detailRecord["conflicts"];
  if (Array.isArray(conflicts)) {
    return conflicts
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const key = (item as Record<string, unknown>)["key"];
          return typeof key === "string" ? key : null;
        }
        return null;
      })
      .filter((key): key is string => key !== null);
  }

  const remote = detailRecord["remote"];
  if (remote !== null && typeof remote === "object" && !Array.isArray(remote)) {
    return Object.keys(remote).sort();
  }

  return [];
}

function handleCommitError(errValue: unknown, deps: CommitCommandDeps): void {
  if (errValue instanceof EnvdError && errValue.code === "commit_conflict") {
    const keys = conflictKeysFromDetails(errValue.details);
    err(deps, `${errValue.message}\n`);
    if (keys.length > 0) {
      err(deps, "Conflicting keys:\n");
      for (const key of keys) {
        err(deps, `  ${key}\n`);
      }
    }
    err(deps, `${errorHintForCode("commit_conflict")}\n`);
    process.exit(1);
  }

  writeCliError(errValue, deps);
}

export function buildCommitCommand(deps: CommitCommandDeps = {}): Command {
  return new Command("commit")
    .description("Push staged changes to the configured provider")
    .argument("[path]", "project directory")
    .option("-m, --message <message>", "provider commit message")
    .option("-e, --environment <name>", "environment to commit")
    .option("--theirs", "resolve conflicts by accepting upstream values")
    .option("--ours", "resolve conflicts by keeping local staged values")
    .option("--yes", "skip the staged-change confirmation prompt")
    .option("--json", "JSON output")
    .option("--no-autostart", "fail instead of starting daemon support")
    .action(async (path: string | undefined, opts: CommitOptions) => {
      try {
        const commandDeps =
          deps.client !== undefined || deps.createClient !== undefined
            ? deps
            : {
                ...deps,
                client: (
                  await ensureCliPreflight({
                    action: "commit changes",
                    noAutostart: opts.noAutostart,
                  })
                ).client,
              };
        const result = await commitProject(path, opts, commandDeps);
        if (opts.json === true) {
          out(deps, JSON.stringify(result) + "\n");
          return;
        }
        printHumanResult(result, deps);
      } catch (error: unknown) {
        handleCommitError(error, deps);
      }
    });
}
