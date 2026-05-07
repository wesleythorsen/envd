import { Command } from "commander";
import { join } from "node:path";
import type { ControlClient, ProjectDetail } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import { ENV_FILE, ensureEnvSymlink } from "../project-files.js";
import {
  resolveProjectRegistrationOrThrow,
  resolveProjectRoot,
} from "../config-file.js";

interface LinkOptions {
  readonly json?: boolean;
  readonly noAutostart?: boolean;
}

interface LinkDeps {
  readonly client: ControlClient;
}

export interface LinkResult {
  readonly status: "linked";
  readonly projectId: string;
  readonly envPath: string;
  readonly symlinkTarget: string;
}

async function getRegisteredProject(
  client: ControlClient,
  projectId: string,
): Promise<ProjectDetail> {
  try {
    return await client.getProject(projectId);
  } catch (err: unknown) {
    if (err instanceof EnvdError && err.code === "not_found") {
      throw new EnvdError(
        "this project needs to be re-initialized on this machine with 'envd init'",
        { code: "not_initialized" },
      );
    }
    throw err;
  }
}

export async function linkProject(
  projectPath: string | undefined,
  deps: LinkDeps,
): Promise<LinkResult> {
  const projectDir = resolveProjectRoot(projectPath);
  const registration = resolveProjectRegistrationOrThrow(projectPath);

  const project = await getRegisteredProject(deps.client, registration.id);
  ensureEnvSymlink(projectDir, project.mountPath);

  return {
    status: "linked",
    projectId: project.id,
    envPath: join(projectDir, ENV_FILE),
    symlinkTarget: project.mountPath,
  };
}

function printResult(result: LinkResult, json: boolean | undefined): void {
  if (json === true) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  process.stdout.write(`envd linked (${result.projectId})\n`);
}

export function buildLinkCommand(): Command {
  return new Command("link")
    .description("Re-create the .env symlink for an initialized project")
    .argument("[path]", "project directory")
    .option("--json", "JSON output")
    .option("--no-autostart", "fail instead of starting daemon/mount support")
    .action(async (path: string | undefined, opts: LinkOptions) => {
      try {
        const preflight = await ensureCliPreflight({
          action: "link project",
          ensureMount: true,
          noAutostart: opts.noAutostart,
        });
        const result = await linkProject(path, {
          client: preflight.client,
        });
        printResult(result, opts.json);
      } catch (err: unknown) {
        writeCliError(err);
      }
    });
}
