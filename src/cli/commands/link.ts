import { Command } from "commander";
import { join, resolve } from "node:path";
import type { ControlClient, ProjectDetail } from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import {
  ENV_FILE,
  ensureEnvSymlink,
  readProjectFile,
} from "../project-files.js";

interface LinkOptions {
  readonly json?: boolean;
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
  const projectDir = resolve(projectPath ?? process.cwd());
  const projectFile = readProjectFile(projectDir);
  if (projectFile === null) {
    throw new EnvdError("project is not initialized", {
      code: "not_initialized",
      details: { path: projectDir },
    });
  }

  const project = await getRegisteredProject(
    deps.client,
    projectFile.projectId,
  );
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
    .action(async (path: string | undefined, opts: LinkOptions) => {
      try {
        const result = await linkProject(path, {
          client: createControlClient(),
        });
        printResult(result, opts.json);
      } catch (err: unknown) {
        writeCliError(err);
      }
    });
}
