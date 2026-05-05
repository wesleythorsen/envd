import { stderr as defaultStderr } from "node:process";
import { EnvdError, type ErrorCode } from "../shared/errors.js";

interface Writable {
  write(chunk: string): unknown;
}

const ERROR_HINTS = {
  daemon_unreachable:
    "Try: start the daemon with `envd daemon start` or inspect `envd daemon status`, then rerun the command.",
  usage_error:
    "Try: rerun the command with `--help` to confirm the required flags and arguments.",
  provider_unreachable:
    "Try: run `envd provider test <id>` and verify the provider host, network access, or service limits.",
  provider_auth:
    "Try: update the provider credentials, then rerun `envd provider test <id>`.",
  commit_conflict:
    "Try: rerun with `envd commit --ours` to keep local values or `envd commit --theirs` to accept remote values.",
  mount_failed:
    "Try: run `envd status` to inspect the mount, then restart the daemon and relink the project.",
  not_initialized:
    "Try: run `envd init` in this project directory before retrying the command.",
  internal:
    "Try: rerun the command, then inspect `envd daemon logs --tail 100` if the problem persists.",
  bad_dotenv:
    "Try: fix the .env syntax and rerun the command, or inspect the rendered output with `envd diff --values`.",
  unauthorized:
    "Try: restart the daemon to refresh local auth state, then rerun the command.",
  not_found:
    "Try: verify the project path, project id, or provider instance id and rerun the command.",
  method_not_allowed:
    "Try: upgrade the CLI and daemon together so both sides support the same command.",
} satisfies Record<ErrorCode, string>;

export function errorHintForCode(code: ErrorCode): string {
  return ERROR_HINTS[code];
}

export function formatCliError(error: unknown): string {
  if (error instanceof EnvdError) {
    return `${error.message}\n${errorHintForCode(error.code)}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function writeCliError(
  error: unknown,
  deps: { readonly stderr?: Writable } = {},
): never {
  (deps.stderr ?? defaultStderr).write(`${formatCliError(error)}\n`);
  process.exit(1);
}
