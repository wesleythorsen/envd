import { Command } from "commander";
import { stdout as defaultStdout } from "node:process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ControlClient,
  ProjectDiffResult,
} from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { DEnvError } from "../../shared/errors.js";
import { colorize } from "../color.js";
import { writeCliError } from "../error-output.js";
import { PROJECT_FILE, parseProjectFile } from "../project-files.js";

interface Writable {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

interface DiffOptions {
  readonly values?: boolean;
  readonly json?: boolean;
}

interface DiffCommandDeps {
  readonly client?: ControlClient;
  readonly createClient?: () => ControlClient;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

function resolveClient(deps: DiffCommandDeps): ControlClient {
  if (deps.client !== undefined) {
    return deps.client;
  }
  return (deps.createClient ?? createControlClient)();
}

function out(deps: DiffCommandDeps, text: string): void {
  (deps.stdout ?? defaultStdout).write(text);
}

export async function diffProject(
  projectPath: string | undefined,
  options: DiffOptions,
  deps: DiffCommandDeps,
): Promise<ProjectDiffResult> {
  const projectDir = resolve(projectPath ?? process.cwd());
  const projectFilePath = join(projectDir, PROJECT_FILE);
  if (!existsSync(projectFilePath)) {
    throw new DEnvError("project is not initialized", {
      code: "not_initialized",
      details: { path: projectDir },
    });
  }

  const projectFile = parseProjectFile(projectFilePath);
  return resolveClient(deps).getProjectDiff(projectFile.projectId, {
    values: options.values === true,
  });
}

function prefixColor(prefix: "+" | "~" | "-"): "green" | "yellow" | "red" {
  switch (prefix) {
    case "+":
      return "green";
    case "~":
      return "yellow";
    case "-":
      return "red";
  }
}

function colorLine(
  line: string,
  prefix: "+" | "~" | "-",
  stream: Writable,
): string {
  return colorize(line, prefixColor(prefix), stream);
}

export function formatDiff(
  diff: ProjectDiffResult,
  includeValues: boolean,
  stream: Writable = defaultStdout,
): string {
  const lines: string[] = [];
  const values = diff.values;

  for (const key of diff.keys.added) {
    const suffix = includeValues ? `=${values?.added[key] ?? ""}` : "";
    lines.push(colorLine(`+${key}${suffix}`, "+", stream));
  }

  for (const key of diff.keys.modified) {
    const change = values?.modified[key];
    const suffix =
      includeValues && change !== undefined
        ? `=${change.before} -> ${change.after}`
        : "";
    lines.push(colorLine(`~${key}${suffix}`, "~", stream));
  }

  for (const key of diff.keys.deleted) {
    const suffix = includeValues ? `=${values?.deleted[key] ?? ""}` : "";
    lines.push(colorLine(`-${key}${suffix}`, "-", stream));
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function handleDiffError(errValue: unknown, deps: DiffCommandDeps): void {
  writeCliError(errValue, deps);
}

export function buildDiffCommand(deps: DiffCommandDeps = {}): Command {
  return new Command("diff")
    .description("Show staged changes against remote secrets")
    .argument("[path]", "project directory")
    .option("--values", "include secret values")
    .option("--json", "JSON output")
    .action(async (path: string | undefined, opts: DiffOptions) => {
      try {
        const diff = await diffProject(path, opts, deps);
        if (opts.json === true) {
          out(deps, JSON.stringify(diff) + "\n");
          return;
        }
        out(
          deps,
          formatDiff(diff, opts.values === true, deps.stdout ?? defaultStdout),
        );
      } catch (error: unknown) {
        handleDiffError(error, deps);
      }
    });
}
