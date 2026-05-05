import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_LOG_FILE_NAME,
  DEFAULT_STATE_DIR_NAME,
  HOME_ENV_VAR,
  MOUNT_PATH_ENV_VAR,
  PID_FILE_NAME,
} from "./product.js";

/** Returns the envd state directory, honoring $ENVD_HOME. */
export function stateDir(): string {
  const override = process.env[HOME_ENV_VAR];
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), DEFAULT_STATE_DIR_NAME);
}

export function pidFile(): string {
  return join(stateDir(), PID_FILE_NAME);
}

export function portsFile(): string {
  return join(stateDir(), "ports.json");
}

export function stateDbFile(): string {
  return join(stateDir(), "state.db");
}

export function controlTokenFile(): string {
  return join(stateDir(), "control-token");
}

export function logDir(): string {
  return join(stateDir(), "logs");
}

export function daemonLogFile(): string {
  return join(logDir(), DAEMON_LOG_FILE_NAME);
}

/**
 * Returns the OS-specific WebDAV mount path.
 * $ENVD_MOUNT_PATH overrides the default.
 * darwin → ~/.envd/mount
 * linux  → ~/.envd/mount
 * other  → throws (unsupported platform)
 */
export function mountPath(): string {
  const override = process.env[MOUNT_PATH_ENV_VAR];
  if (override !== undefined && override !== "") {
    return override;
  }

  switch (process.platform) {
    case "darwin":
    case "linux":
      return join(stateDir(), "mount");
    default:
      throw new Error(
        `mountPath(): unsupported platform "${process.platform}"`,
      );
  }
}

/** Creates the state directory (and parents) if it does not already exist. */
export function ensureStateDir(): void {
  mkdirSync(stateDir(), { recursive: true });
}
