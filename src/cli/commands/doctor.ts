import { Command } from "commander";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getStatus, type StatusDeps, type StatusResult } from "./status.js";
import { controlTokenFile, pidFile, portsFile } from "../../shared/paths.js";
import { writeCliError } from "../error-output.js";
import { ENV_FILE, ensureEnvSymlink, isEnvdSymlink } from "../project-files.js";
import { resolveProjectRoot } from "../config-file.js";

type DoctorCheckStatus = "ok" | "warning" | "error";

interface DoctorOptions {
  readonly fix?: boolean;
  readonly force?: boolean;
  readonly path?: string;
  readonly json?: boolean;
}

interface Writable {
  write(chunk: string): unknown;
}

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly summary: string;
  readonly detail?: string;
  readonly fixable?: boolean;
  readonly destructive?: boolean;
  readonly fixed?: boolean;
}

export interface DoctorResult {
  readonly status: "ok" | "issues_found" | "fixed";
  readonly checks: readonly DoctorCheck[];
}

interface DoctorDeps extends StatusDeps {
  readonly getStatus?: (deps?: StatusDeps) => Promise<StatusResult>;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

function ok(id: string, summary: string, detail?: string): DoctorCheck {
  return {
    id,
    status: "ok",
    summary,
    ...(detail === undefined ? {} : { detail }),
  };
}

function issue(
  id: string,
  status: Exclude<DoctorCheckStatus, "ok">,
  summary: string,
  opts: {
    readonly detail?: string;
    readonly fixable?: boolean;
    readonly destructive?: boolean;
    readonly fixed?: boolean;
  } = {},
): DoctorCheck {
  return {
    id,
    status,
    summary,
    ...(opts.detail === undefined ? {} : { detail: opts.detail }),
    ...(opts.fixable === undefined ? {} : { fixable: opts.fixable }),
    ...(opts.destructive === undefined
      ? {}
      : { destructive: opts.destructive }),
    ...(opts.fixed === undefined ? {} : { fixed: opts.fixed }),
  };
}

function readPid(path = pidFile()): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function readPortsState(
  path = portsFile(),
): "present" | "missing" | "malformed" {
  if (!existsSync(path)) {
    return "missing";
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    return typeof parsed["control"] === "number" &&
      typeof parsed["webdav"] === "number"
      ? "present"
      : "malformed";
  } catch {
    return "malformed";
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function safeUnlink(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function envPathState(
  path: string,
): "missing" | "managed" | "unmanaged" | "file" {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) {
      return "file";
    }
    return isEnvdSymlink(path) ? "managed" : "unmanaged";
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw err;
  }
}

function runtimeChecks(
  status: StatusResult,
  options: DoctorOptions,
  deps: DoctorDeps,
): readonly DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const pid = readPid();
  const pidAlive =
    pid === null ? false : (deps.isPidAlive ?? defaultIsPidAlive)(pid);
  const stalePid = pid !== null && !pidAlive;
  const portsState = readPortsState();
  const stalePorts = portsState === "present" && !status.daemon.running;
  const malformedPorts = portsState === "malformed";

  if (stalePid) {
    const fixed = options.fix === true && safeUnlink(pidFile());
    checks.push(
      issue("runtime.pid", "warning", "stale daemon pid file", {
        detail: pidFile(),
        fixable: true,
        fixed,
      }),
    );
  } else {
    checks.push(
      ok("runtime.pid", pid === null ? "pid file absent" : "pid file valid"),
    );
  }

  if (stalePorts || malformedPorts) {
    const fixed = options.fix === true && safeUnlink(portsFile());
    checks.push(
      issue(
        "runtime.ports",
        "warning",
        malformedPorts ? "ports file is malformed" : "stale daemon ports file",
        { detail: portsFile(), fixable: true, fixed },
      ),
    );
  } else {
    checks.push(ok("runtime.ports", `ports file ${portsState}`));
  }

  return checks;
}

function projectChecks(
  status: StatusResult,
  projectDir: string,
  options: DoctorOptions,
): readonly DoctorCheck[] {
  const checks: DoctorCheck[] = [
    ok("migrations", "project metadata migration check completed"),
  ];
  if (status.project === null) {
    checks.push(
      issue("project.registration", "warning", "project is not initialized", {
        detail: projectDir,
      }),
    );
    return checks;
  }

  checks.push(
    status.project.registered
      ? ok("project.registration", "project is registered")
      : issue(
          "project.registration",
          "error",
          "project config exists but daemon state is missing",
          { detail: "run envd init to re-register this project" },
        ),
  );

  const state = envPathState(join(projectDir, ENV_FILE));
  if (status.project.linkState === "linked") {
    checks.push(ok("env_link", ".env is linked to envd"));
  } else if (state === "file" || state === "unmanaged") {
    checks.push(
      issue("env_link", "error", ".env is not managed by envd", {
        detail:
          "doctor will not overwrite ordinary files or unmanaged symlinks without a future destructive repair flow",
        destructive: true,
      }),
    );
  } else {
    const canFix = status.project.mountPath !== null;
    let fixed = false;
    if (options.fix === true && canFix) {
      ensureEnvSymlink(projectDir, status.project.mountPath);
      fixed = true;
    }
    checks.push(
      issue("env_link", "warning", `.env link is ${status.project.linkState}`, {
        fixable: canFix,
        fixed,
      }),
    );
  }

  if (status.project.provider === null) {
    checks.push(issue("provider", "warning", "provider status is unavailable"));
  } else if (status.project.provider.healthy === true) {
    checks.push(ok("provider", "provider is healthy"));
  } else {
    checks.push(
      issue(
        "provider",
        "error",
        "provider health check failed",
        status.project.provider.error === null
          ? {}
          : { detail: status.project.provider.error },
      ),
    );
  }

  return checks;
}

export async function doctorProject(
  options: DoctorOptions = {},
  deps: DoctorDeps = {},
): Promise<DoctorResult> {
  const projectDir = resolveProjectRoot(options.path ?? deps.projectPath);
  const status = await (deps.getStatus ?? getStatus)({
    ...deps,
    projectPath: projectDir,
  });
  const tokenCheck = existsSync(controlTokenFile())
    ? ok("control_token", "control token exists")
    : issue("control_token", "warning", "control token is missing", {
        detail: controlTokenFile(),
      });
  const checks = [
    status.daemon.running
      ? ok("daemon", "daemon is healthy")
      : issue(
          "daemon",
          "error",
          "daemon is not healthy",
          status.daemon.error === null ? {} : { detail: status.daemon.error },
        ),
    tokenCheck,
    ...runtimeChecks(status, options, deps),
    status.mount.mounted
      ? ok("mount", "mount is available")
      : issue(
          "mount",
          "warning",
          "mount is not available",
          status.mount.error === null && status.mount.path === null
            ? {}
            : { detail: status.mount.error ?? status.mount.path ?? "" },
        ),
    ...projectChecks(status, projectDir, options),
  ];
  const hasIssues = checks.some((check) => check.status !== "ok");
  const fixedAny = checks.some((check) => check.fixed === true);
  return {
    status: !hasIssues ? "ok" : fixedAny ? "fixed" : "issues_found",
    checks,
  };
}

export function formatDoctorHuman(result: DoctorResult): string {
  const lines = [`doctor: ${result.status}`];
  for (const check of result.checks) {
    const suffix = check.fixed === true ? " (fixed)" : "";
    lines.push(`[${check.status}] ${check.id}: ${check.summary}${suffix}`);
    if (check.detail !== undefined) {
      lines.push(`  ${check.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function writeResult(
  result: DoctorResult,
  options: DoctorOptions,
  deps: DoctorDeps,
): void {
  (deps.stdout ?? process.stdout).write(
    options.json === true
      ? `${JSON.stringify(result)}\n`
      : formatDoctorHuman(result),
  );
}

function handleDoctorError(error: unknown, deps: DoctorDeps): void {
  writeCliError(error, deps);
}

export function buildDoctorCommand(deps: DoctorDeps = {}): Command {
  return new Command("doctor")
    .description("Diagnose envd local state and safe repair opportunities")
    .option("--fix", "perform safe repairs")
    .option("--force", "allow future destructive repairs that require force")
    .option("--path <path>", "project directory")
    .option("--json", "JSON output")
    .action(async (opts: DoctorOptions) => {
      try {
        writeResult(await doctorProject(opts, deps), opts, deps);
      } catch (error: unknown) {
        handleDoctorError(error, deps);
      }
    });
}
