import { execFile as nodeExecFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { EnvdError } from "../shared/errors.js";
import { createLogger } from "../shared/logger.js";
import type { MountAdapter } from "./adapter.js";

const log = createLogger("mount/darwin");

// ---------------------------------------------------------------------------
// Shell-out helper
// ---------------------------------------------------------------------------

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Function signature matching `execFile` after promisification, exposed for DI in tests. */
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

/** `fs.mkdir` signature subset used by the adapter, exposed for DI in tests. */
export type MkdirFn = (
  path: string,
  opts: { recursive: true },
) => Promise<string | undefined>;

/**
 * Default runner using `execFile` (no shell, no injection risk).
 * Resolves with { stdout, stderr, code } even on non-zero exit.
 */
async function defaultRunner(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    nodeExecFile(cmd, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err === null) {
        resolve({ stdout, stderr, code: 0 });
      } else {
        // err.code is the exit code (number) or a signal name (string).
        const code = typeof err.code === "number" ? err.code : 1;
        resolve({ stdout, stderr, code });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Darwin adapter
// ---------------------------------------------------------------------------

export class DarwinMountAdapter implements MountAdapter {
  readonly platform = "darwin" as const;

  /** Injected in tests; defaults to the real execFile-based runner. */
  private readonly run: Runner;

  /** Injected in tests; defaults to fs.mkdir. */
  private readonly mkdirFn: MkdirFn;

  constructor(runner: Runner = defaultRunner, mkdirFn: MkdirFn = mkdir) {
    this.run = runner;
    this.mkdirFn = mkdirFn;
  }

  /**
   * Checks whether `path` is an active mount point by parsing `mount` output.
   * We look for a line whose mount-on field equals `path`.
   *
   * Typical line format:
   *   <device>|<url> on <mountpoint> (<type>, ...)
   */
  async isMounted(path: string): Promise<boolean> {
    const { stdout } = await this.run("/sbin/mount", []);
    // Normalise trailing slash so /Volumes/foo and /Volumes/foo/ both match.
    const target = path.endsWith("/") ? path.slice(0, -1) : path;
    for (const line of stdout.split("\n")) {
      // Match "... on <mountpoint> ..."
      const match = / on (.+?) \(/.exec(line);
      if (match !== null) {
        const mp = match[1]?.endsWith("/") ? match[1].slice(0, -1) : match[1];
        if (mp === target) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Creates the mount point directory if needed, then calls `mount_webdav`.
   * Verifies the mount succeeded via `isMounted` afterwards.
   */
  async mount(url: string, path: string): Promise<void> {
    log.info({ msg: "mounting WebDAV", data: { url, path } });

    // Ensure mount point exists.
    await this.mkdirFn(path, { recursive: true });

    // -S suppresses auth UI; -v sets the display name shown in Finder.
    const { stderr, code } = await this.run("/sbin/mount_webdav", [
      "-S",
      "-v",
      "envd",
      url,
      path,
    ]);

    if (code !== 0) {
      throw new EnvdError("mount_webdav failed", {
        code: "mount_failed",
        details: { url, path, stderr },
      });
    }

    const mounted = await this.isMounted(path);
    if (!mounted) {
      throw new EnvdError(
        "mount_webdav returned success but path is not mounted",
        {
          code: "mount_failed",
          details: { url, path, stderr },
        },
      );
    }

    log.info({ msg: "WebDAV mounted", data: { path } });
  }

  /**
   * Unmounts `path`. Retries once after 250 ms on EBUSY (exit code 16 or
   * stderr containing "Resource busy").
   */
  async unmount(path: string): Promise<void> {
    log.info({ msg: "unmounting", data: { path } });

    const result = await this.run("/sbin/umount", [path]);

    if (result.code === 0) {
      log.info({ msg: "unmounted", data: { path } });
      return;
    }

    const isBusy =
      result.code === 16 || result.stderr.includes("Resource busy");

    if (!isBusy) {
      throw new EnvdError("umount failed", {
        code: "mount_failed",
        details: { path, stderr: result.stderr, exitCode: result.code },
      });
    }

    // Retry once after a short delay.
    log.warn({ msg: "umount EBUSY — retrying after 250 ms", data: { path } });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    const retry = await this.run("/sbin/umount", [path]);
    if (retry.code !== 0) {
      throw new EnvdError("umount failed after retry", {
        code: "mount_failed",
        details: { path, stderr: retry.stderr, exitCode: retry.code },
      });
    }

    log.info({ msg: "unmounted (after retry)", data: { path } });
  }
}
