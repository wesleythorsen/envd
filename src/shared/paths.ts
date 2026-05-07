import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_LOG_FILE_NAME,
  HOME_ENV_VAR,
  MOUNT_PATH_ENV_VAR,
  PID_FILE_NAME,
} from "./product.js";

function envdHomeOverride(): string | null {
  const override = process.env[HOME_ENV_VAR];
  return override === undefined || override === "" ? null : override;
}

function xdgDir(envVar: string, fallback: string): string {
  const override = process.env[envVar];
  if (override !== undefined && override !== "") {
    return join(override, "envd");
  }
  return fallback;
}

/** Returns the envd user-editable config directory. */
export function configDir(): string {
  return (
    envdHomeOverride() ??
    xdgDir("XDG_CONFIG_HOME", join(homedir(), ".config", "envd"))
  );
}

export function configFile(): string {
  return join(configDir(), "config.toml");
}

/** Returns the envd durable state directory, honoring $ENVD_HOME. */
export function stateDir(): string {
  return (
    envdHomeOverride() ??
    xdgDir("XDG_STATE_HOME", join(homedir(), ".local", "state", "envd"))
  );
}

export function cacheDir(): string {
  return (
    envdHomeOverride() ??
    xdgDir("XDG_CACHE_HOME", join(homedir(), ".cache", "envd"))
  );
}

export function runtimeDir(): string {
  const homeOverride = envdHomeOverride();
  if (homeOverride !== null) {
    return homeOverride;
  }
  const runtime = process.env["XDG_RUNTIME_DIR"];
  if (runtime !== undefined && runtime !== "") {
    return join(runtime, "envd");
  }
  return join(stateDir(), "run");
}

export function pidFile(): string {
  return join(runtimeDir(), PID_FILE_NAME);
}

export function portsFile(): string {
  return join(runtimeDir(), "ports.json");
}

export function stateDbFile(): string {
  return join(stateDir(), "state.db");
}

export function controlTokenFile(): string {
  return join(runtimeDir(), "control-token");
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
 * darwin → <runtimeDir>/mount
 * linux  → <runtimeDir>/mount
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
      return join(runtimeDir(), "mount");
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

/** Creates the runtime directory used for pid/token/port files. */
export function ensureRuntimeDir(): void {
  mkdirSync(runtimeDir(), { recursive: true });
}
