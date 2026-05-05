import { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ControlClient, ProjectDetail } from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { DEnvError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import {
  ENV_FILE,
  PROJECT_FILE,
  ensureEnvSymlink,
  parseProjectFile,
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
    if (err instanceof DEnvError && err.code === "not_found") {
      throw new DEnvError(
        "this project needs to be re-initialized on this machine with 'd-env init'",
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
  const projectFilePath = join(projectDir, PROJECT_FILE);
  if (!existsSync(projectFilePath)) {
    throw new DEnvError("project is not initialized", {
      code: "not_initialized",
      details: { path: projectDir },
    });
  }

  const projectFile = parseProjectFile(projectFilePath);
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
  process.stdout.write(`d-env linked (${result.projectId})\n`);
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
