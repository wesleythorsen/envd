import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEnvError } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import type { MountAdapter } from "./adapter.js";

const log = createLogger("mount/linux");
const DAVFS_INSTALL_HINT = "install davfs2 first (apt install davfs2 or dnf install davfs2)";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;
export type MkdirFn = (
  path: string,
  opts: { recursive: true },
) => Promise<string | undefined>;
export type MkdtempFn = (prefix: string) => Promise<string>;
export type WriteFileFn = (path: string, data: string) => Promise<void>;
export type RemoveFn = (
  path: string,
  opts: { recursive: true; force: true },
) => Promise<void>;

async function defaultRunner(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    nodeExecFile(cmd, args, { encoding: "utf8" }, (err, stdout, stderr) => {
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
    });
  });
}

function normalizeMountPath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function missingDavfs(result: RunResult): boolean {
  return (
    result.code === 127 ||
    /not found|no such file or directory/i.test(result.stderr)
  );
}

function missingDavfsError(): DEnvError {
  return new DEnvError(DAVFS_INSTALL_HINT, {
    code: "mount_failed",
  });
}

function mountFailure(
  message: string,
  details: Record<string, unknown>,
): DEnvError {
  return new DEnvError(message, {
    code: "mount_failed",
    details,
  });
}

export class LinuxMountAdapter implements MountAdapter {
  readonly platform = "linux" as const;

  private readonly configDirs = new Map<string, string>();
  private readonly run: Runner;
  private readonly mkdirFn: MkdirFn;
  private readonly mkdtempFn: MkdtempFn;
  private readonly writeFileFn: WriteFileFn;
  private readonly removeFn: RemoveFn;

  constructor(
    runner: Runner = defaultRunner,
    mkdirFn: MkdirFn = mkdir,
    mkdtempFn: MkdtempFn = mkdtemp,
    writeFileFn: WriteFileFn = writeFile,
    removeFn: RemoveFn = rm,
  ) {
    this.run = runner;
    this.mkdirFn = mkdirFn;
    this.mkdtempFn = mkdtempFn;
    this.writeFileFn = writeFileFn;
    this.removeFn = removeFn;
  }

  async isMounted(path: string): Promise<boolean> {
    const { stdout } = await this.run("mount", []);
    const target = normalizeMountPath(path);

    for (const line of stdout.split("\n")) {
      const match = / on (.+?) type /.exec(line);
      if (match === null) {
        continue;
      }
      if (normalizeMountPath(match[1] ?? "") === target) {
        return true;
      }
    }

    return false;
  }

  private async ensureDavfsInstalled(): Promise<void> {
    const result = await this.run("mount.davfs", ["-V"]);
    if (result.code === 0) {
      return;
    }
    if (missingDavfs(result)) {
      throw missingDavfsError();
    }
    throw mountFailure("mount.davfs is unavailable", {
      exitCode: result.code,
      stderr: result.stderr,
    });
  }

  private async cleanupConfigDir(path: string): Promise<void> {
    const configDir = this.configDirs.get(path);
    if (configDir === undefined) {
      return;
    }
    this.configDirs.delete(path);
    await this.removeFn(configDir, { recursive: true, force: true });
  }

  async mount(url: string, path: string): Promise<void> {
    log.info({ msg: "mounting WebDAV", data: { url, path } });

    await this.ensureDavfsInstalled();
    await this.mkdirFn(path, { recursive: true });

    const configDir = await this.mkdtempFn(join(tmpdir(), "d-env-davfs2-"));
    const configPath = join(configDir, "davfs2.conf");
    await this.writeFileFn(configPath, "use_locks 0\n");
    this.configDirs.set(path, configDir);

    const result = await this.run("mount.davfs", [
      "-o",
      `conf=${configPath}`,
      url,
      path,
    ]);

    if (result.code !== 0) {
      await this.cleanupConfigDir(path);
      if (missingDavfs(result)) {
        throw missingDavfsError();
      }
      throw mountFailure("mount.davfs failed", {
        url,
        path,
        exitCode: result.code,
        stderr: result.stderr,
      });
    }

    if (!(await this.isMounted(path))) {
      await this.cleanupConfigDir(path);
      throw mountFailure(
        "mount.davfs returned success but path is not mounted",
        {
          url,
          path,
          stderr: result.stderr,
        },
      );
    }

    log.info({ msg: "WebDAV mounted", data: { path } });
  }

  async unmount(path: string): Promise<void> {
    log.info({ msg: "unmounting", data: { path } });

    const result = await this.run("umount", [path]);
    if (result.code !== 0) {
      throw mountFailure("umount failed", {
        path,
        exitCode: result.code,
        stderr: result.stderr,
      });
    }

    await this.cleanupConfigDir(path);
    log.info({ msg: "unmounted", data: { path } });
  }
}
