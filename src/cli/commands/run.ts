import { spawn } from "node:child_process";
import { Command } from "commander";
import type {
  ProjectEnvironmentValuesOptions,
  ProjectEnvironmentValuesResult,
} from "../../ipc/control-client.js";
import { readProjectEnvironmentValues } from "../../ipc/control-client.js";
import { EnvdError } from "../../shared/errors.js";
import { writeCliError } from "../error-output.js";
import { ensureCliPreflight } from "../preflight.js";
import { resolveProjectRegistrationOrThrow } from "../config-file.js";

interface Writable {
  write(chunk: string): unknown;
}

interface RunOptions {
  readonly path?: string;
  readonly noAutostart?: boolean;
}

interface RunInvocation {
  readonly environment?: string;
  readonly command: readonly string[];
}

type ReadEnvironmentFn = (
  projectId: string,
  opts?: ProjectEnvironmentValuesOptions,
) => Promise<ProjectEnvironmentValuesResult>;

type SpawnCommandFn = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<number>;

interface RunCommandDeps {
  readonly readEnvironment?: ReadEnvironmentFn;
  readonly spawnCommand?: SpawnCommandFn;
  readonly stderr?: Writable;
}

type CommandWithRawArgs = Command & {
  readonly rawArgs?: readonly string[];
};

export interface RunResult {
  readonly status: "exited";
  readonly projectId: string;
  readonly environment: string;
  readonly exitCode: number;
}

function stripRunOptions(args: readonly string[]): readonly string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-autostart") {
      continue;
    }
    if (arg === "--path") {
      index += 1;
      continue;
    }
    if (arg?.startsWith("--path=") === true) {
      continue;
    }
    if (arg?.startsWith("-") === true) {
      throw new EnvdError(`unknown envd run option before --: ${arg}`, {
        code: "usage_error",
      });
    }
    if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return positional;
}

export function parseRunInvocation(rawArgs: readonly string[]): RunInvocation {
  const separatorIndex = rawArgs.indexOf("--");
  if (separatorIndex < 0) {
    throw new EnvdError("usage: envd run [environment] -- <command...>", {
      code: "usage_error",
    });
  }

  const beforeSeparator = stripRunOptions(rawArgs.slice(0, separatorIndex));
  if (beforeSeparator.length > 1) {
    throw new EnvdError("envd run accepts at most one environment argument", {
      code: "usage_error",
    });
  }

  const command = rawArgs.slice(separatorIndex + 1);
  if (command.length === 0) {
    throw new EnvdError("envd run requires a command after --", {
      code: "usage_error",
    });
  }

  return {
    ...(beforeSeparator[0] === undefined
      ? {}
      : { environment: beforeSeparator[0] }),
    command,
  };
}

function defaultSpawnCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
    });
    child.once("error", (err: Error) => {
      reject(
        new EnvdError(`failed to start child process: ${err.message}`, {
          code: "usage_error",
          cause: err,
        }),
      );
    });
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

export async function runProject(
  invocation: RunInvocation,
  options: RunOptions,
  deps: RunCommandDeps = {},
): Promise<RunResult> {
  const registration = resolveProjectRegistrationOrThrow(options.path);
  const environment = invocation.environment ?? registration.activeEnvironment;
  const readEnvironment = deps.readEnvironment ?? readProjectEnvironmentValues;
  const rendered = await readEnvironment(registration.id, { environment });
  const [command, ...args] = invocation.command;
  if (command === undefined) {
    throw new EnvdError("envd run requires a command after --", {
      code: "usage_error",
    });
  }

  const exitCode = await (deps.spawnCommand ?? defaultSpawnCommand)(
    command,
    args,
    { ...process.env, ...rendered.values },
  );
  return {
    status: "exited",
    projectId: registration.id,
    environment: rendered.environment,
    exitCode,
  };
}

function handleRunError(errValue: unknown, deps: RunCommandDeps): void {
  writeCliError(errValue, deps);
}

export function buildRunCommand(deps: RunCommandDeps = {}): Command {
  return new Command("run")
    .description("Run a command with secrets from a project environment")
    .allowUnknownOption(true)
    .passThroughOptions()
    .argument("[tokens...]", "optional environment, then -- and command")
    .option("--path <path>", "project directory")
    .option("--no-autostart", "fail instead of starting daemon support")
    .action(function (
      this: Command,
      _tokens: readonly string[],
      opts: RunOptions,
    ) {
      return (async () => {
        try {
          if (deps.readEnvironment === undefined) {
            await ensureCliPreflight({
              action: "run command",
              noAutostart: opts.noAutostart,
            });
          }
          const rawArgs = (this as CommandWithRawArgs).rawArgs ?? _tokens;
          const result = await runProject(
            parseRunInvocation(rawArgs),
            opts,
            deps,
          );
          if (result.exitCode !== 0) {
            process.exit(result.exitCode);
          }
        } catch (error: unknown) {
          handleRunError(error, deps);
        }
      })();
    });
}
