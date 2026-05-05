import { Command } from "commander";
import { stdout as defaultStdout } from "node:process";
import { resolve } from "node:path";
import type {
  ControlClient,
  ProjectDiffResult,
} from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { formatDiff } from "./diff.js";
import { readProjectFile } from "../project-files.js";

interface Writable {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

interface PullOptions {
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

interface PullCommandDeps {
  readonly client?: ControlClient;
  readonly createClient?: () => ControlClient;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

export type PullResult =
  | {
      readonly status: "dry_run";
      readonly projectId: string;
      readonly diff: ProjectDiffResult;
    }
  | {
      readonly status: "pulled";
      readonly projectId: string;
      readonly snapshotFetchedAt: number;
    };

function resolveClient(deps: PullCommandDeps): ControlClient {
  if (deps.client !== undefined) {
    return deps.client;
  }
  return (deps.createClient ?? createControlClient)();
}

function out(deps: PullCommandDeps, text: string): void {
  (deps.stdout ?? defaultStdout).write(text);
}

function resolveProjectId(projectPath: string | undefined): string {
  const projectDir = resolve(projectPath ?? process.cwd());
  const projectFile = readProjectFile(projectDir);
  if (projectFile === null) {
    throw new EnvdError("project is not initialized", {
      code: "not_initialized",
      details: { path: projectDir },
    });
  }

  return projectFile.projectId;
}

function hasDiff(diff: ProjectDiffResult): boolean {
  return (
    diff.keys.added.length > 0 ||
    diff.keys.modified.length > 0 ||
    diff.keys.deleted.length > 0
  );
}

export async function pullProject(
  projectPath: string | undefined,
  options: PullOptions,
  deps: PullCommandDeps,
): Promise<PullResult> {
  const projectId = resolveProjectId(projectPath);
  const client = resolveClient(deps);

  if (options.dryRun === true) {
    return {
      status: "dry_run",
      projectId,
      diff: await client.getProjectDiff(projectId),
    };
  }

  const result = await client.pullProject(projectId, {
    force: options.force === true,
  });
  return {
    status: "pulled",
    projectId,
    snapshotFetchedAt: result.snapshotFetchedAt,
  };
}

function printHumanResult(result: PullResult, deps: PullCommandDeps): void {
  if (result.status === "dry_run") {
    if (!hasDiff(result.diff)) {
      out(
        deps,
        "No staged changes; pull would refresh the provider snapshot.\n",
      );
      return;
    }

    out(deps, "Pull would discard staged changes:\n");
    out(deps, formatDiff(result.diff, false, deps.stdout ?? defaultStdout));
    return;
  }

  out(deps, `envd pulled (snapshot fetched at ${result.snapshotFetchedAt})\n`);
}

function handlePullError(errValue: unknown, deps: PullCommandDeps): void {
  writeCliError(errValue, deps);
}

export function buildPullCommand(deps: PullCommandDeps = {}): Command {
  return new Command("pull")
    .description("Drop local staging and refresh the provider snapshot")
    .argument("[path]", "project directory")
    .option("--force", "discard staged changes")
    .option("--dry-run", "show what would change without pulling")
    .option("--json", "JSON output")
    .action(async (path: string | undefined, opts: PullOptions) => {
      try {
        const result = await pullProject(path, opts, deps);
        if (opts.json === true) {
          out(deps, JSON.stringify(result) + "\n");
          return;
        }
        printHumanResult(result, deps);
      } catch (error: unknown) {
        handlePullError(error, deps);
      }
    });
}
