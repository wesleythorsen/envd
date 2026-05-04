import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Returns the d-env state directory, honoring $D_ENV_HOME. Defaults to ~/.d-env/. */
export function stateDir(): string {
  const override = process.env["D_ENV_HOME"];
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), ".d-env");
}

export function pidFile(): string {
  return join(stateDir(), "d-envd.pid");
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

/**
 * Returns the OS-specific WebDAV mount path.
 * $D_ENV_MOUNT_PATH overrides the default.
 * darwin → ~/.d-env/mount
 * linux  → ~/.d-env/mount
 * other  → throws (unsupported platform)
 */
export function mountPath(): string {
  const override = process.env["D_ENV_MOUNT_PATH"];
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
