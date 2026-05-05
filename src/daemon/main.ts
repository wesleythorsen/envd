#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createLogger } from "../shared/logger.js";
import { startWebdavServer } from "./webdav/server.js";
import { startControlServer, generateToken } from "./control/server.js";
import {
  controlTokenFile,
  ensureStateDir,
  pidFile,
  portsFile,
  stateDbFile,
} from "../shared/paths.js";
import { openState } from "../core/state.js";
import { ProjectRepo } from "../core/project.js";
import { ProviderInstanceRepo } from "../core/provider-instance.js";
import { createKeychainAdapter } from "../core/keychain.js";

// createRequire is the stable way to load JSON in ESM without import assertions
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require("../../package.json");
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const version = pkg.version as string;

const log = createLogger("daemon");

/**
 * Loads or creates the control API token.
 *
 * If the token file does not exist, generates a fresh token and writes it with
 * mode 0600. Handles the race where two daemon instances start simultaneously
 * by using the exclusive-create flag ("wx") and falling back to a read on EEXIST.
 */
function loadOrCreateToken(): string {
  ensureStateDir();
  const tokenPath = controlTokenFile();

  // Happy path: file already exists.
  try {
    return readFileSync(tokenPath, "utf-8").trim();
  } catch (err: unknown) {
    // Only proceed to create if the file is genuinely absent.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  // File is absent — generate and try to write exclusively.
  const token = generateToken();
  try {
    writeFileSync(tokenPath, token, { mode: 0o600, flag: "wx" });
    log.info({
      msg: "Generated new control API token",
      data: { path: tokenPath },
    });
    return token;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    // Another process won the race; read theirs.
    return readFileSync(tokenPath, "utf-8").trim();
  }
}

/**
 * Checks for a stale PID file on startup and enforces single-instance.
 *
 * NOTE: process.kill(pid, 0) only confirms a process with that PID exists;
 * it does not prove the process is our daemon. A reused PID (e.g. from a
 * crash + OS recycling) could yield a false positive. Acceptable for v1.
 */
function checkPidFile(): void {
  const pidPath = pidFile();
  let existingPid: number | undefined;

  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    existingPid = parseInt(raw, 10);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return; // No PID file — nothing to check.
    }
    throw err;
  }

  if (existingPid === undefined || isNaN(existingPid)) {
    log.warn({
      msg: "PID file unreadable; removing stale file",
      data: { path: pidPath },
    });
    rmSync(pidPath, { force: true });
    return;
  }

  try {
    process.kill(existingPid, 0);
    // Process is alive — refuse to start.
    log.error({
      msg: "d-envd already running; refusing to start",
      data: { pid: existingPid },
    });
    process.exit(1);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // Process is dead — stale file; clean it up and continue.
      log.warn({
        msg: "Stale PID file found; removing and continuing",
        data: { stalePid: existingPid, path: pidPath },
      });
      rmSync(pidPath, { force: true });
    } else {
      throw err;
    }
  }
}

function writePidFile(): void {
  writeFileSync(pidFile(), String(process.pid), { encoding: "utf-8" });
}

function writePortsFile(controlPort: number, webdavPort: number): void {
  writeFileSync(
    portsFile(),
    JSON.stringify({ control: controlPort, webdav: webdavPort }),
    { encoding: "utf-8" },
  );
}

function cleanupFiles(): void {
  rmSync(pidFile(), { force: true });
  rmSync(portsFile(), { force: true });
}

async function main(): Promise<void> {
  log.info({ msg: `d-envd starting`, data: { version, pid: process.pid } });

  ensureStateDir();
  checkPidFile();
  writePidFile();

  const token = loadOrCreateToken();
  const state = openState(stateDbFile());
  const projectRepo = new ProjectRepo(state.db);
  const providerInstanceRepo = new ProviderInstanceRepo(state.db);
  const keychain = createKeychainAdapter();

  // Shutdown logic shared by SIGTERM and the /v1/shutdown endpoint.
  // Defined here so both paths call the exact same code.
  let shutdownInProgress = false;
  function triggerShutdown(
    webdav: { close(): Promise<void> },
    ctrl: { close(): Promise<void> },
  ): void {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;
    log.info({ msg: "d-envd shutting down" });
    Promise.all([webdav.close(), ctrl.close()])
      .catch((err: unknown) => {
        log.error({
          msg: "error during shutdown",
          data: { error: String(err) },
        });
      })
      .finally(() => {
        state.close();
        cleanupFiles();
        process.exit(0);
      });
  }

  // Start the control server with a placeholder onShutdown — we'll replace it
  // once we have both server handles. Use a closure reference so we can late-bind.
  // Using a mutable box so onShutdown (captured at server-start time) can call
  // triggerShutdown with both handles after Promise.all resolves.
  const shutdownBox: { fn?: () => void } = {};

  const [webdav, control] = await Promise.all([
    startWebdavServer({ projectRepo, providerInstanceRepo, keychain }),
    startControlServer({
      token,
      projectRepo,
      providerInstanceRepo,
      keychain,
      onShutdown: () => {
        shutdownBox.fn?.();
      },
    }),
  ]);

  // Now wire up the real shutdown with both handles.
  shutdownBox.fn = () => {
    triggerShutdown(webdav, control);
  };

  writePortsFile(control.port, webdav.port);

  log.info({
    msg: "d-envd ready",
    data: { webdavPort: webdav.port, controlPort: control.port },
  });

  process.on("SIGTERM", () => {
    log.info({ msg: "d-envd received SIGTERM, shutting down" });
    triggerShutdown(webdav, control);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`d-envd fatal: ${String(err)}\n`);
  process.exit(1);
});
