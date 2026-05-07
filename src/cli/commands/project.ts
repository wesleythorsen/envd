import { Command } from "commander";
import type {
  ControlClient,
  ProjectProviderMoveResult,
} from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import {
  registerProject,
  resolveProjectRegistrationOrThrow,
} from "../config-file.js";

interface ProjectMoveOptions {
  readonly provider?: string;
  readonly purge?: boolean;
  readonly json?: boolean;
  readonly noAutostart?: boolean;
}

interface ProjectDeps {
  readonly client: ControlClient;
}

export async function moveProjectProvider(
  projectPath: string | undefined,
  options: ProjectMoveOptions,
  deps: ProjectDeps,
): Promise<ProjectProviderMoveResult> {
  if (options.provider === undefined || options.provider.trim() === "") {
    throw new EnvdError("--provider is required", { code: "usage_error" });
  }
  const registration = resolveProjectRegistrationOrThrow(projectPath);
  const result = await deps.client.moveProjectProvider(registration.id, {
    provider: options.provider,
    purge: options.purge === true,
  });
  registerProject({
    ...registration,
    providerInstanceId: result.providerInstanceId,
  });
  return result;
}

function printMoveResult(
  result: ProjectProviderMoveResult,
  json: boolean | undefined,
): void {
  if (json === true) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  process.stdout.write(
    `envd project moved (${result.movedEnvironments.length} environments)\n`,
  );
}

export function buildProjectCommand(): Command {
  const command = new Command("project").description("Manage envd projects");

  command
    .command("move")
    .description("Move the current project to another provider instance/org")
    .argument("[path]", "project directory")
    .requiredOption(
      "--provider <name>",
      "target provider instance/org name or id",
    )
    .option("--purge", "remove source provider values after verified move")
    .option("--json", "JSON output")
    .option("--no-autostart", "fail instead of starting daemon support")
    .action(async (path: string | undefined, opts: ProjectMoveOptions) => {
      try {
        const preflight = await ensureCliPreflight({
          action: "move project",
          noAutostart: opts.noAutostart,
        });
        const result = await moveProjectProvider(path, opts, {
          client: preflight.client,
        });
        printMoveResult(result, opts.json);
      } catch (err: unknown) {
        writeCliError(err);
      }
    });

  return command;
}
