#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { RotatingFileLogSink } from "../shared/log-file.js";
import { createLogger, setLogWriter } from "../shared/logger.js";
import { startWebdavServer } from "./webdav/server.js";
import { startControlServer, generateToken } from "./control/server.js";
import {
  controlTokenFile,
  daemonLogFile,
  ensureRuntimeDir,
  ensureStateDir,
  pidFile,
  portsFile,
  stateDbFile,
} from "../shared/paths.js";
import { createCache } from "../core/cache.js";
import { loadOrCreateDaemonKey } from "../core/daemon-key.js";
import { openState } from "../core/state.js";
import { ProjectRepo } from "../core/project.js";
import { createEncryptedStagingCodec, StagingRepo } from "../core/staging.js";
import { ProviderInstanceRepo } from "../core/provider-instance.js";
import { createKeychainAdapter } from "../core/keychain.js";
import type { SecretMap } from "../providers/base.js";
import {
  CONTROL_PORT_ENV_VAR,
  LOG_FORMAT_ENV_VAR,
  WEBDAV_PORT_ENV_VAR,
} from "../shared/product.js";

// createRequire is the stable way to load JSON in ESM without import assertions
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require("../../package.json");
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const version = pkg.version as string;

const log = createLogger("daemon");

function portFromEnv(envVar: string): number | undefined {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${envVar} must be an integer from 0 to 65535`);
  }
  return port;
}

/**
 * Loads or creates the control API token.
 *
 * If the token file does not exist, generates a fresh token and writes it with
 * mode 0600. Handles the race where two daemon instances start simultaneously
 * by using the exclusive-create flag ("wx") and falling back to a read on EEXIST.
 */
function loadOrCreateToken(): string {
  ensureRuntimeDir();
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
      msg: "envdd already running; refusing to start",
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
  ensureRuntimeDir();
  writeFileSync(pidFile(), String(process.pid), { encoding: "utf-8" });
}

function writePortsFile(controlPort: number, webdavPort: number): void {
  ensureRuntimeDir();
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

function formatFatalError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

function writeFatalStartupLog(err: unknown): void {
  try {
    const logSink = new RotatingFileLogSink(daemonLogFile());
    logSink.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        scope: "daemon",
        msg: "envdd fatal",
        data: { error: formatFatalError(err) },
      })}\n`,
    );
  } catch {
    // If the log path itself is broken, stderr is still the source of truth.
  }
}

async function main(): Promise<void> {
  ensureStateDir();
  ensureRuntimeDir();
  if (process.env[LOG_FORMAT_ENV_VAR] === undefined) {
    process.env[LOG_FORMAT_ENV_VAR] = "json";
  }
  const logSink = new RotatingFileLogSink(daemonLogFile());
  setLogWriter((line) => {
    logSink.write(line);
  });

  log.info({ msg: `envdd starting`, data: { version, pid: process.pid } });

  checkPidFile();
  writePidFile();

  const token = loadOrCreateToken();
  const keychain = createKeychainAdapter();
  const state = openState(stateDbFile());
  const projectRepo = new ProjectRepo(state.db);
  const bootstrapStagingRepo = new StagingRepo(state.db);
  const daemonKey = await loadOrCreateDaemonKey(keychain, {
    mustExist: bootstrapStagingRepo.hasEncryptedRows(),
  });
  const stagingRepo = new StagingRepo(state.db, {
    codec: createEncryptedStagingCodec(daemonKey),
  });
  stagingRepo.reencryptLegacyRows();
  const providerInstanceRepo = new ProviderInstanceRepo(state.db);
  const cache = createCache<SecretMap>();

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
    log.info({ msg: "envdd shutting down" });
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
  const webdavPort = portFromEnv(WEBDAV_PORT_ENV_VAR);
  const controlPort = portFromEnv(CONTROL_PORT_ENV_VAR);

  const [webdav, control] = await Promise.all([
    startWebdavServer({
      ...(webdavPort === undefined ? {} : { port: webdavPort }),
      projectRepo,
      stagingRepo,
      providerInstanceRepo,
      keychain,
      cache,
    }),
    startControlServer({
      ...(controlPort === undefined ? {} : { port: controlPort }),
      token,
      projectRepo,
      providerInstanceRepo,
      stagingRepo,
      cache,
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
    msg: "envdd ready",
    data: { webdavPort: webdav.port, controlPort: control.port },
  });

  process.on("SIGTERM", () => {
    log.info({ msg: "envdd received SIGTERM, shutting down" });
    triggerShutdown(webdav, control);
  });
}

main().catch((err: unknown) => {
  writeFatalStartupLog(err);
  process.stderr.write(`envdd fatal: ${formatFatalError(err)}\n`);
  process.exit(1);
});
