import { Command } from "commander";
import { join } from "node:path";
import type { ControlClient } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import { ENV_FILE, removeEnvSymlink } from "../project-files.js";
import {
  findProjectRegistration,
  migrateLegacyProjectFile,
  removeProjectRegistration,
  resolveProjectRoot,
} from "../config-file.js";

interface UnlinkOptions {
  readonly json?: boolean;
  readonly purge?: boolean;
  readonly noAutostart?: boolean;
}

interface UnlinkDeps {
  readonly client?: ControlClient;
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
  const projectDir = resolveProjectRoot(projectPath);
  const envPath = join(projectDir, ENV_FILE);

  migrateLegacyProjectFile(projectDir);
  const registration = findProjectRegistration(projectDir);
  const projectId = registration?.id ?? null;

  if (options.purge === true && projectId === null) {
    throw new EnvdError("cannot purge an uninitialized project", {
      code: "not_initialized",
      details: { path: projectDir },
    });
  }

  const removedSymlink = removeEnvSymlink(projectDir);
  if (options.purge === true && projectId !== null) {
    if (deps.client === undefined) {
      throw new EnvdError("cannot purge without daemon client", {
        code: "daemon_unreachable",
      });
    }
    await deps.client.deleteProject(projectId);
    removeProjectRegistration(projectId);
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
    .option("--no-autostart", "fail instead of starting daemon support")
    .action(async (path: string | undefined, opts: UnlinkOptions) => {
      try {
        const deps =
          opts.purge === true
            ? {
                client: (
                  await ensureCliPreflight({
                    action: "unlink project",
                    noAutostart: opts.noAutostart,
                  })
                ).client,
              }
            : {};
        const result = await unlinkProject(path, opts, deps);
        printResult(result, opts.json);
      } catch (err: unknown) {
        writeCliError(err);
      }
    });
}
