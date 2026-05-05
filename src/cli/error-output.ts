import { stderr as defaultStderr } from "node:process";
import { DEnvError, type ErrorCode } from "../shared/errors.js";

interface Writable {
  write(chunk: string): unknown;
}

const ERROR_HINTS = {
  daemon_unreachable:
    "Try: start the daemon with `d-env daemon start` or inspect `d-env daemon status`, then rerun the command.",
  usage_error:
    "Try: rerun the command with `--help` to confirm the required flags and arguments.",
  provider_unreachable:
    "Try: run `d-env provider test <id>` and verify the provider host, network access, or service limits.",
  provider_auth:
    "Try: update the provider credentials, then rerun `d-env provider test <id>`.",
  commit_conflict:
    "Try: rerun with `d-env commit --ours` to keep local values or `d-env commit --theirs` to accept remote values.",
  mount_failed:
    "Try: run `d-env status` to inspect the mount, then restart the daemon and relink the project.",
  not_initialized:
    "Try: run `d-env init` in this project directory before retrying the command.",
  internal:
    "Try: rerun the command, then inspect `d-env daemon logs --tail 100` if the problem persists.",
  bad_dotenv:
    "Try: fix the .env syntax and rerun the command, or inspect the rendered output with `d-env diff --values`.",
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
  if (error instanceof DEnvError) {
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
