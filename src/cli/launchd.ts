import { execFile as nodeExecFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EnvdError } from "../shared/errors.js";
import { logDir } from "../shared/paths.js";
import {
  HOME_ENV_VAR,
  LAUNCHD_LABEL,
  LAUNCHD_STDERR_LOG_NAME,
  LAUNCHD_STDOUT_LOG_NAME,
  MOUNT_PATH_ENV_VAR,
} from "../shared/product.js";

export { LAUNCHD_LABEL };
export const LAUNCHD_PLIST_NAME = `${LAUNCHD_LABEL}.plist`;

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type Runner = (
  cmd: string,
  args: readonly string[],
) => Promise<RunResult>;

type MkdirFn = (
  path: string,
  opts: { readonly recursive: true },
) => Promise<string | undefined>;

type WriteFileFn = (
  path: string,
  data: string,
  opts: { readonly mode: number },
) => Promise<void>;

type RemoveFileFn = (
  path: string,
  opts: { readonly force: true },
) => Promise<void>;

type AccessFn = (path: string) => Promise<void>;

export interface LaunchdInstallOptions {
  readonly daemonPath: string;
  readonly nodePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly plistPath?: string;
  readonly stateLogDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: Runner;
  readonly mkdirFn?: MkdirFn;
  readonly writeFileFn?: WriteFileFn;
  readonly accessFn?: AccessFn;
}

export interface LaunchdUninstallOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly plistPath?: string;
  readonly run?: Runner;
  readonly removeFileFn?: RemoveFileFn;
  readonly accessFn?: AccessFn;
}

export interface LaunchdInstallResult {
  readonly status: "installed";
  readonly label: string;
  readonly plistPath: string;
}

export interface LaunchdUninstallResult {
  readonly status: "uninstalled" | "not_installed";
  readonly label: string;
  readonly plistPath: string;
}

async function defaultRunner(
  cmd: string,
  args: readonly string[],
): Promise<RunResult> {
  return new Promise((resolve) => {
    nodeExecFile(
      cmd,
      [...args],
      { encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        resolve({
          stdout,
          stderr,
          code: typeof err.code === "number" ? err.code : 1,
        });
      },
    );
  });
}

function assertDarwin(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new EnvdError("launchd daemon install is only supported on macOS", {
      code: "usage_error",
      details: { platform },
    });
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isNotFoundError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "ENOENT";
}

async function fileExists(path: string, accessFn: AccessFn): Promise<boolean> {
  try {
    await accessFn(path);
    return true;
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function launchctlError(
  action: "load" | "unload",
  plistPath: string,
  result: RunResult,
): EnvdError {
  return new EnvdError(`launchctl ${action} failed`, {
    code: "internal",
    details: {
      plistPath,
      exitCode: result.code,
      stderr: result.stderr,
    },
  });
}

function escapePlistString(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchdEnvironment(
  env: NodeJS.ProcessEnv,
): readonly [string, string][] {
  const entries: [string, string][] = [];
  const path = env["PATH"];
  const envdHome = env[HOME_ENV_VAR];
  const envdMountPath = env[MOUNT_PATH_ENV_VAR];

  if (path !== undefined && path !== "") {
    entries.push(["PATH", path]);
  }
  if (envdHome !== undefined && envdHome !== "") {
    entries.push([HOME_ENV_VAR, envdHome]);
  }
  if (envdMountPath !== undefined && envdMountPath !== "") {
    entries.push([MOUNT_PATH_ENV_VAR, envdMountPath]);
  }

  return entries;
}

function environmentPlist(env: readonly [string, string][]): string {
  if (env.length === 0) {
    return "";
  }

  const lines = ["  <key>EnvironmentVariables</key>", "  <dict>"];
  for (const [key, value] of env) {
    lines.push(
      `    <key>${escapePlistString(key)}</key>`,
      `    <string>${escapePlistString(value)}</string>`,
    );
  }
  lines.push("  </dict>");
  return `${lines.join("\n")}\n`;
}

export function launchAgentPlistPath(homeDir: string = homedir()): string {
  return join(homeDir, "Library", "LaunchAgents", LAUNCHD_PLIST_NAME);
}

export function createLaunchdPlist(opts: {
  readonly daemonPath: string;
  readonly nodePath: string;
  readonly stateLogDir: string;
  readonly env: NodeJS.ProcessEnv;
}): string {
  const escapedLabel = escapePlistString(LAUNCHD_LABEL);
  const escapedNodePath = escapePlistString(opts.nodePath);
  const escapedDaemonPath = escapePlistString(opts.daemonPath);
  const stdoutPath = escapePlistString(
    join(opts.stateLogDir, LAUNCHD_STDOUT_LOG_NAME),
  );
  const stderrPath = escapePlistString(
    join(opts.stateLogDir, LAUNCHD_STDERR_LOG_NAME),
  );
  const envBlock = environmentPlist(launchdEnvironment(opts.env));

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapedLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapedNodePath}</string>
    <string>${escapedDaemonPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
${envBlock}</dict>
</plist>
`;
}

async function unloadIfPresent(run: Runner, plistPath: string): Promise<void> {
  await run("launchctl", ["unload", plistPath]);
}

export async function installLaunchdAgent(
  opts: LaunchdInstallOptions,
): Promise<LaunchdInstallResult> {
  const platform = opts.platform ?? process.platform;
  assertDarwin(platform);

  const plistPath = opts.plistPath ?? launchAgentPlistPath(opts.homeDir);
  const run = opts.run ?? defaultRunner;
  const mkdirFn = opts.mkdirFn ?? mkdir;
  const writeFileFn = opts.writeFileFn ?? writeFile;
  const accessFn = opts.accessFn ?? access;
  const stateLogDir = opts.stateLogDir ?? logDir();

  await mkdirFn(dirname(plistPath), { recursive: true });
  await mkdirFn(stateLogDir, { recursive: true });

  if (await fileExists(plistPath, accessFn)) {
    await unloadIfPresent(run, plistPath);
  }

  await writeFileFn(
    plistPath,
    createLaunchdPlist({
      daemonPath: opts.daemonPath,
      nodePath: opts.nodePath ?? process.execPath,
      stateLogDir,
      env: opts.env ?? process.env,
    }),
    { mode: 0o644 },
  );

  const loadResult = await run("launchctl", ["load", plistPath]);
  if (loadResult.code !== 0) {
    throw launchctlError("load", plistPath, loadResult);
  }

  return { status: "installed", label: LAUNCHD_LABEL, plistPath };
}

export async function uninstallLaunchdAgent(
  opts: LaunchdUninstallOptions = {},
): Promise<LaunchdUninstallResult> {
  const platform = opts.platform ?? process.platform;
  assertDarwin(platform);

  const plistPath = opts.plistPath ?? launchAgentPlistPath(opts.homeDir);
  const run = opts.run ?? defaultRunner;
  const removeFileFn = opts.removeFileFn ?? rm;
  const accessFn = opts.accessFn ?? access;

  if (!(await fileExists(plistPath, accessFn))) {
    return { status: "not_installed", label: LAUNCHD_LABEL, plistPath };
  }

  const unloadResult = await run("launchctl", ["unload", plistPath]);
  if (unloadResult.code !== 0) {
    throw launchctlError("unload", plistPath, unloadResult);
  }

  await removeFileFn(plistPath, { force: true });
  return { status: "uninstalled", label: LAUNCHD_LABEL, plistPath };
}
