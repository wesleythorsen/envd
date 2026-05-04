import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type {
  ControlClient,
  CreateProjectResult,
  ProjectDetail,
} from "../../ipc/control-client.js";
import { createControlClient } from "../../ipc/control-client.js";
import { DEnvError } from "../../shared/errors.js";
import { createMountAdapter } from "../../mount/index.js";
import { mountPath, portsFile } from "../../shared/paths.js";
import type { MountAdapter } from "../../mount/adapter.js";
import {
  ENV_FILE,
  PROJECT_FILE,
  ensureEnvSymlink,
  ensureGitignore,
  parseProjectFile,
  writeProjectFile,
  type ProjectFile,
} from "../project-files.js";

interface InitOptions {
  readonly yes?: boolean;
  readonly json?: boolean;
}

interface InitProjectDeps {
  readonly client: ControlClient;
  readonly mountAdapter?: MountAdapter;
  readonly ensureMount?: boolean;
  readonly confirm?: (projectPath: string) => Promise<boolean>;
}

export interface InitResult {
  readonly status: "initialized" | "already_initialized";
  readonly projectId: string;
  readonly envPath: string;
  readonly symlinkTarget: string;
}

function readWebdavUrl(): string {
  // as-cast justified: ports.json is a daemon-owned serialization boundary.
  const ports = JSON.parse(readFileSync(portsFile(), "utf-8")) as Record<
    string,
    unknown
  >;
  const webdav = ports["webdav"];
  if (typeof webdav !== "number") {
    throw new DEnvError("ports file is missing webdav port", {
      code: "daemon_unreachable",
    });
  }
  return `http://127.0.0.1:${webdav}/`;
}

async function ensureMounted(adapter: MountAdapter): Promise<void> {
  const path = mountPath();
  if (await adapter.isMounted(path)) {
    return;
  }
  await adapter.mount(readWebdavUrl(), path);
}

async function promptConfirm(projectPath: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Initialize d-env in ${projectPath}? [y/N] `,
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

function printResult(result: InitResult, json: boolean | undefined): void {
  if (json === true) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  if (result.status === "already_initialized") {
    process.stdout.write(`d-env already initialized (${result.projectId})\n`);
  } else {
    process.stdout.write(`d-env initialized (${result.projectId})\n`);
  }
}

async function existingProjectResult(
  client: ControlClient,
  projectDir: string,
  projectFile: ProjectFile,
): Promise<InitResult> {
  let project: ProjectDetail;
  try {
    project = await client.getProject(projectFile.projectId);
  } catch (err: unknown) {
    if (err instanceof DEnvError && err.code === "not_found") {
      throw new DEnvError(
        "this project is not registered on this machine; run d-env init again after removing .d-env.json",
        { code: "not_initialized" },
      );
    }
    throw err;
  }

  ensureGitignore(projectDir);
  ensureEnvSymlink(projectDir, project.mountPath);

  return {
    status: "already_initialized",
    projectId: project.id,
    envPath: join(projectDir, ENV_FILE),
    symlinkTarget: project.mountPath,
  };
}

async function newProjectResult(
  client: ControlClient,
  projectDir: string,
): Promise<InitResult> {
  const created: CreateProjectResult = await client.createProject({
    path: projectDir,
  });
  writeProjectFile(projectDir, created.id);
  ensureGitignore(projectDir);
  ensureEnvSymlink(projectDir, created.mountPath);

  return {
    status: "initialized",
    projectId: created.id,
    envPath: join(projectDir, ENV_FILE),
    symlinkTarget: created.mountPath,
  };
}

export async function initProject(
  projectPath: string | undefined,
  options: InitOptions,
  deps: InitProjectDeps,
): Promise<InitResult> {
  const projectDir = resolve(projectPath ?? process.cwd());
  if (!existsSync(projectDir)) {
    throw new DEnvError("project path does not exist", {
      code: "usage_error",
      details: { path: projectDir },
    });
  }

  if (options.yes !== true) {
    const confirm = deps.confirm ?? promptConfirm;
    if (!(await confirm(projectDir))) {
      throw new DEnvError("initialization cancelled", { code: "usage_error" });
    }
  }

  if (deps.ensureMount !== false) {
    const adapter = deps.mountAdapter ?? (await createMountAdapter());
    await ensureMounted(adapter);
  }

  const projectFilePath = join(projectDir, PROJECT_FILE);
  if (existsSync(projectFilePath)) {
    return existingProjectResult(
      deps.client,
      projectDir,
      parseProjectFile(projectFilePath),
    );
  }

  return newProjectResult(deps.client, projectDir);
}

export function buildInitCommand(): Command {
  return new Command("init")
    .description("Initialize d-env in a project directory")
    .argument("[path]", "project directory")
    .option("--yes", "skip confirmation prompt")
    .option("--json", "JSON output")
    .action(async (path: string | undefined, opts: InitOptions) => {
      try {
        const result = await initProject(path, opts, {
          client: createControlClient(),
        });
        printResult(result, opts.json);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${message}\n`);
        process.exit(1);
      }
    });
}
