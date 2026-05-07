import { mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Re-import after env mutations by using a dynamic import trick:
// Since module caching means stateDir() reads process.env at call time (not
// module load time), we can simply set the env var before each call.
import {
  cacheDir,
  configDir,
  configFile,
  controlTokenFile,
  daemonLogFile,
  ensureStateDir,
  logDir,
  mountPath,
  pidFile,
  portsFile,
  runtimeDir,
  stateDir,
} from "../../src/shared/paths.js";

const ENV_KEYS = [
  "ENVD_HOME",
  "ENVD_MOUNT_PATH",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

function snapshotEnv(): Partial<Record<EnvKey, string>> {
  const snapshot: Partial<Record<EnvKey, string>> = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function restoreEnv(snapshot: Partial<Record<EnvKey, string>>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("envd directory resolution", () => {
  let original: Partial<Record<EnvKey, string>>;

  beforeEach(() => {
    original = snapshotEnv();
    clearEnv();
  });

  afterEach(() => {
    restoreEnv(original);
  });

  it("uses XDG-style defaults", () => {
    expect(configDir()).toBe(join(homedir(), ".config/envd"));
    expect(configFile()).toBe(join(homedir(), ".config/envd/config.toml"));
    expect(stateDir()).toBe(join(homedir(), ".local/state/envd"));
    expect(cacheDir()).toBe(join(homedir(), ".cache/envd"));
    expect(runtimeDir()).toBe(join(homedir(), ".local/state/envd/run"));
  });

  it("honors XDG overrides", () => {
    process.env["XDG_CONFIG_HOME"] = "/xdg/config";
    process.env["XDG_STATE_HOME"] = "/xdg/state";
    process.env["XDG_CACHE_HOME"] = "/xdg/cache";
    process.env["XDG_RUNTIME_DIR"] = "/xdg/runtime";

    expect(configDir()).toBe("/xdg/config/envd");
    expect(configFile()).toBe("/xdg/config/envd/config.toml");
    expect(stateDir()).toBe("/xdg/state/envd");
    expect(cacheDir()).toBe("/xdg/cache/envd");
    expect(runtimeDir()).toBe("/xdg/runtime/envd");
  });

  it("honors ENVD_HOME override", () => {
    process.env["ENVD_HOME"] = "/tmp/custom-envd";
    process.env["XDG_CONFIG_HOME"] = "/xdg/config";
    process.env["XDG_STATE_HOME"] = "/xdg/state";
    process.env["XDG_CACHE_HOME"] = "/xdg/cache";
    process.env["XDG_RUNTIME_DIR"] = "/xdg/runtime";

    expect(configDir()).toBe("/tmp/custom-envd");
    expect(configFile()).toBe("/tmp/custom-envd/config.toml");
    expect(stateDir()).toBe("/tmp/custom-envd");
    expect(cacheDir()).toBe("/tmp/custom-envd");
    expect(runtimeDir()).toBe("/tmp/custom-envd");
  });

  it("ignores empty ENVD_HOME and falls back to default", () => {
    process.env["ENVD_HOME"] = "";
    const dir = stateDir();
    expect(dir).toMatch(/\.local\/state\/envd$/);
  });
});

describe("derived path functions", () => {
  beforeEach(() => {
    process.env["ENVD_HOME"] = "/tmp/envd-test";
  });

  afterEach(() => {
    delete process.env["ENVD_HOME"];
  });

  it("pidFile() is inside stateDir()", () => {
    expect(pidFile()).toBe(join(runtimeDir(), "envdd.pid"));
  });

  it("portsFile() is inside stateDir()", () => {
    expect(portsFile()).toBe(join(runtimeDir(), "ports.json"));
  });

  it("controlTokenFile() is inside stateDir()", () => {
    expect(controlTokenFile()).toBe(join(runtimeDir(), "control-token"));
  });

  it("logDir() is inside stateDir()", () => {
    expect(logDir()).toBe(join(stateDir(), "logs"));
  });

  it("daemonLogFile() is inside logDir()", () => {
    expect(daemonLogFile()).toBe(join(logDir(), "envdd.log"));
  });
});

describe("mountPath()", () => {
  beforeEach(() => {
    process.env["ENVD_HOME"] = "/tmp/envd-test";
  });

  afterEach(() => {
    delete process.env["ENVD_HOME"];
    delete process.env["ENVD_MOUNT_PATH"];
  });

  it("honors ENVD_MOUNT_PATH override", () => {
    process.env["ENVD_MOUNT_PATH"] = "/tmp/custom-mount";
    expect(mountPath()).toBe("/tmp/custom-mount");
  });

  it("returns stateDir/mount on darwin", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    try {
      expect(mountPath()).toBe("/tmp/envd-test/mount");
    } finally {
      Object.defineProperty(process, "platform", {
        value: orig,
        configurable: true,
      });
    }
  });

  it("returns stateDir/mount on linux", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      expect(mountPath()).toBe("/tmp/envd-test/mount");
    } finally {
      Object.defineProperty(process, "platform", {
        value: orig,
        configurable: true,
      });
    }
  });

  it("throws on unsupported platforms", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    try {
      expect(() => mountPath()).toThrow(/unsupported platform/);
    } finally {
      Object.defineProperty(process, "platform", {
        value: orig,
        configurable: true,
      });
    }
  });
});

describe("ensureStateDir()", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "envd-paths-test-"));
    process.env["ENVD_HOME"] = join(tmpBase, "state");
  });

  afterEach(() => {
    delete process.env["ENVD_HOME"];
    // best-effort cleanup
    try {
      rmSync(tmpBase, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("creates the state directory", () => {
    ensureStateDir();
    const s = statSync(stateDir());
    expect(s.isDirectory()).toBe(true);
  });

  it("is idempotent", () => {
    ensureStateDir();
    expect(() => ensureStateDir()).not.toThrow();
  });
});
