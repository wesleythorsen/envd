import { Command } from "commander";
import { join, resolve } from "node:path";
import type { ControlClient } from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import {
  ENV_FILE,
  readProjectFile,
  removeEnvSymlink,
} from "../project-files.js";

interface UnlinkOptions {
  readonly json?: boolean;
  readonly purge?: boolean;
}

interface UnlinkDeps {
  readonly client: ControlClient;
}

export interface UnlinkResult {
  readonly status: "unlinked";
  readonly projectId: string | null;
  readonly envPath: string;
  readonly removedSymlink: boolean;
  readonly purged: boolean;
}

export async function unlinkProject(
  projectPath: string | undefined,
  options: UnlinkOptions,
  deps: UnlinkDeps,
): Promise<UnlinkResult> {
  const projectDir = resolve(projectPath ?? process.cwd());
  const envPath = join(projectDir, ENV_FILE);

  const projectFile = readProjectFile(projectDir);
  const projectId = projectFile?.projectId ?? null;

  if (options.purge === true && projectId === null) {
    throw new EnvdError("cannot purge without .envd.json", {
      code: "not_initialized",
      details: { path: projectDir },
    });
  }

  const removedSymlink = removeEnvSymlink(projectDir);
  if (options.purge === true && projectId !== null) {
    await deps.client.deleteProject(projectId);
  }

  return {
    status: "unlinked",
    projectId,
    envPath,
    removedSymlink,
    purged: options.purge === true,
  };
}

function printResult(result: UnlinkResult, json: boolean | undefined): void {
  if (json === true) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  const suffix = result.purged ? " and purged" : "";
  process.stdout.write(`envd unlinked${suffix}\n`);
}

export function buildUnlinkCommand(): Command {
  return new Command("unlink")
    .description("Remove the .env symlink for an initialized project")
    .argument("[path]", "project directory")
    .option("--purge", "also remove the project from the daemon registry")
    .option("--json", "JSON output")
    .action(async (path: string | undefined, opts: UnlinkOptions) => {
      try {
        const result = await unlinkProject(path, opts, {
          client: createControlClient(),
        });
        printResult(result, opts.json);
      } catch (err: unknown) {
        writeCliError(err);
      }
    });
}
