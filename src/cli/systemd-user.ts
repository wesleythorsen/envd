import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EnvdError } from "../shared/errors.js";
import { SYSTEMD_USER_SERVICE_NAME } from "../shared/product.js";

export { SYSTEMD_USER_SERVICE_NAME };

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type SystemdRunner = (args: readonly string[]) => Promise<RunResult>;

export type MkdirFn = (
  path: string,
  opts: { readonly recursive: true },
) => Promise<string | undefined>;

export type WriteFileFn = (
  path: string,
  data: string,
  opts: { readonly mode: number },
) => Promise<void>;

export type RemoveFn = (
  path: string,
  opts: { readonly force: true },
) => Promise<void>;

export interface SystemdUserServiceDeps {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly nodePath?: string;
  readonly runSystemctl?: SystemdRunner;
  readonly mkdirFn?: MkdirFn;
  readonly writeFileFn?: WriteFileFn;
  readonly removeFn?: RemoveFn;
}

export interface SystemdUserServiceResult {
  readonly status: "installed" | "uninstalled";
  readonly serviceName: string;
  readonly unitPath: string;
}

type DaemonPathResolver = string | (() => string);

export interface InstallSystemdUserServiceOptions extends SystemdUserServiceDeps {
  readonly daemonPath: DaemonPathResolver;
}

function defaultSystemctlRunner(args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    nodeExecFile(
      "systemctl",
      ["--user", ...args],
      { encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }

        const errCode = (err as NodeJS.ErrnoException).code;
        if (errCode === "ENOENT") {
          resolve({ stdout, stderr, code: 127 });
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

function systemdUserDir(homeDir: string): string {
  return join(homeDir, ".config", "systemd", "user");
}

export function systemdUserServicePath(homeDir = homedir()): string {
  return join(systemdUserDir(homeDir), SYSTEMD_USER_SERVICE_NAME);
}

function assertLinux(platform: NodeJS.Platform): void {
  if (platform !== "linux") {
    throw new EnvdError(
      "systemd --user daemon install is only supported on linux",
      {
        code: "usage_error",
        details: { platform },
      },
    );
  }
}

function escapeSystemdUnitPercent(value: string): string {
  return value.replaceAll("%", "%%");
}

export function quoteSystemdExecArg(value: string): string {
  const escaped = escapeSystemdUnitPercent(value);
  if (/^[A-Za-z0-9_@+=:,./-]+$/.test(escaped)) {
    return escaped;
  }
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildSystemdUserUnit(opts: {
  readonly nodePath: string;
  readonly daemonPath: string;
}): string {
  const execStart = [
    quoteSystemdExecArg(opts.nodePath),
    quoteSystemdExecArg(opts.daemonPath),
  ].join(" ");

  return [
    "[Unit]",
    "Description=envd daemon",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=2s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

async function runSystemctlChecked(
  runSystemctl: SystemdRunner,
  args: readonly string[],
): Promise<void> {
  const result = await runSystemctl(args);
  if (result.code === 0) {
    return;
  }

  const detail =
    result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  throw new EnvdError(`systemctl --user ${args.join(" ")} failed: ${detail}`, {
    code: "internal",
    details: {
      command: "systemctl",
      args: ["--user", ...args],
      exitCode: result.code,
      stderr: result.stderr,
      stdout: result.stdout,
    },
  });
}

async function uninstallExistingService(
  runSystemctl: SystemdRunner,
  unitPath: string,
  removeFn: RemoveFn,
): Promise<void> {
  await runSystemctlChecked(runSystemctl, [
    "disable",
    SYSTEMD_USER_SERVICE_NAME,
  ]);
  await runSystemctlChecked(runSystemctl, ["stop", SYSTEMD_USER_SERVICE_NAME]);
  await removeFn(unitPath, { force: true });
  await runSystemctlChecked(runSystemctl, ["daemon-reload"]);
}

function resolveDaemonPath(path: DaemonPathResolver): string {
  return typeof path === "function" ? path() : path;
}

export async function installSystemdUserService(
  opts: InstallSystemdUserServiceOptions,
): Promise<SystemdUserServiceResult> {
  const platform = opts.platform ?? process.platform;
  assertLinux(platform);

  const homeDir = opts.homeDir ?? homedir();
  const unitPath = systemdUserServicePath(homeDir);
  const unit = buildSystemdUserUnit({
    nodePath: opts.nodePath ?? process.execPath,
    daemonPath: resolveDaemonPath(opts.daemonPath),
  });
  const mkdirFn = opts.mkdirFn ?? mkdir;
  const writeFileFn = opts.writeFileFn ?? writeFile;
  const runSystemctl = opts.runSystemctl ?? defaultSystemctlRunner;

  await mkdirFn(dirname(unitPath), { recursive: true });
  await writeFileFn(unitPath, unit, { mode: 0o644 });
  await runSystemctlChecked(runSystemctl, ["daemon-reload"]);
  await runSystemctlChecked(runSystemctl, [
    "enable",
    SYSTEMD_USER_SERVICE_NAME,
  ]);
  await runSystemctlChecked(runSystemctl, ["start", SYSTEMD_USER_SERVICE_NAME]);

  return {
    status: "installed",
    serviceName: SYSTEMD_USER_SERVICE_NAME,
    unitPath,
  };
}

export async function uninstallSystemdUserService(
  opts: SystemdUserServiceDeps = {},
): Promise<SystemdUserServiceResult> {
  const platform = opts.platform ?? process.platform;
  assertLinux(platform);

  const homeDir = opts.homeDir ?? homedir();
  const unitPath = systemdUserServicePath(homeDir);
  const removeFn = opts.removeFn ?? rm;
  const runSystemctl = opts.runSystemctl ?? defaultSystemctlRunner;
  await uninstallExistingService(runSystemctl, unitPath, removeFn);

  return {
    status: "uninstalled",
    serviceName: SYSTEMD_USER_SERVICE_NAME,
    unitPath,
  };
}
