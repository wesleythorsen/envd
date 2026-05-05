import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Re-import after env mutations by using a dynamic import trick:
// Since module caching means stateDir() reads process.env at call time (not
// module load time), we can simply set the env var before each call.
import {
  controlTokenFile,
  daemonLogFile,
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
    original = process.env["ENVD_HOME"];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["ENVD_HOME"];
    } else {
      process.env["ENVD_HOME"] = original;
    }
  });

  it("returns a non-empty string by default", () => {
    delete process.env["ENVD_HOME"];
    const dir = stateDir();
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
  });

  it("defaults to ~/.envd/", () => {
    delete process.env["ENVD_HOME"];
    const dir = stateDir();
    expect(dir).toMatch(/\.envd$/);
  });

  it("honors ENVD_HOME override", () => {
    process.env["ENVD_HOME"] = "/tmp/custom-envd";
    expect(stateDir()).toBe("/tmp/custom-envd");
  });

  it("ignores empty ENVD_HOME and falls back to default", () => {
    process.env["ENVD_HOME"] = "";
    const dir = stateDir();
    expect(dir).toMatch(/\.envd$/);
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
    expect(pidFile()).toBe(join(stateDir(), "envdd.pid"));
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
