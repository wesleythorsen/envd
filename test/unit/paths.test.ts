import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Re-import after env mutations by using a dynamic import trick:
// Since module caching means stateDir() reads process.env at call time (not
// module load time), we can simply set the env var before each call.
import {
  controlTokenFile,
  ensureStateDir,
  logDir,
  mountPath,
  pidFile,
  portsFile,
  stateDir,
} from "../../src/shared/paths.js";

describe("stateDir()", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env["D_ENV_HOME"];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["D_ENV_HOME"];
    } else {
      process.env["D_ENV_HOME"] = original;
    }
  });

  it("returns a non-empty string by default", () => {
    delete process.env["D_ENV_HOME"];
    const dir = stateDir();
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
  });

  it("defaults to ~/.d-env/", () => {
    delete process.env["D_ENV_HOME"];
    const dir = stateDir();
    expect(dir).toMatch(/\.d-env$/);
  });

  it("honors D_ENV_HOME override", () => {
    process.env["D_ENV_HOME"] = "/tmp/custom-d-env";
    expect(stateDir()).toBe("/tmp/custom-d-env");
  });

  it("ignores empty D_ENV_HOME and falls back to default", () => {
    process.env["D_ENV_HOME"] = "";
    const dir = stateDir();
    expect(dir).toMatch(/\.d-env$/);
  });
});

describe("derived path functions", () => {
  beforeEach(() => {
    process.env["D_ENV_HOME"] = "/tmp/d-env-test";
  });

  afterEach(() => {
    delete process.env["D_ENV_HOME"];
  });

  it("pidFile() is inside stateDir()", () => {
    expect(pidFile()).toBe(join(stateDir(), "d-envd.pid"));
  });

  it("portsFile() is inside stateDir()", () => {
    expect(portsFile()).toBe(join(stateDir(), "ports.json"));
  });

  it("controlTokenFile() is inside stateDir()", () => {
    expect(controlTokenFile()).toBe(join(stateDir(), "control-token"));
  });

  it("logDir() is inside stateDir()", () => {
    expect(logDir()).toBe(join(stateDir(), "logs"));
  });
});

describe("mountPath()", () => {
  beforeEach(() => {
    process.env["D_ENV_HOME"] = "/tmp/d-env-test";
  });

  afterEach(() => {
    delete process.env["D_ENV_HOME"];
    delete process.env["D_ENV_MOUNT_PATH"];
  });

  it("honors D_ENV_MOUNT_PATH override", () => {
    process.env["D_ENV_MOUNT_PATH"] = "/tmp/custom-mount";
    expect(mountPath()).toBe("/tmp/custom-mount");
  });

  it("returns stateDir/mount on darwin", () => {
    const orig = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    try {
      expect(mountPath()).toBe("/tmp/d-env-test/mount");
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
      expect(mountPath()).toBe("/tmp/d-env-test/mount");
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
    tmpBase = mkdtempSync(join(tmpdir(), "d-env-paths-test-"));
    process.env["D_ENV_HOME"] = join(tmpBase, "state");
  });

  afterEach(() => {
    delete process.env["D_ENV_HOME"];
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
