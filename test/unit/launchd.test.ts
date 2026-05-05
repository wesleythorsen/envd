import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHD_LABEL,
  createLaunchdPlist,
  installLaunchdAgent,
  launchAgentPlistPath,
  uninstallLaunchdAgent,
  type Runner,
  type RunResult,
} from "../../src/cli/launchd.js";

interface RunCall {
  readonly cmd: string;
  readonly args: readonly string[];
}

function withTempHome(fn: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = mkdtempSync(join(tmpdir(), "d-env-launchd-test-"));
  return fn(homeDir).finally(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });
}

function recordingRunner(
  result: RunResult = { stdout: "", stderr: "", code: 0 },
): { readonly calls: RunCall[]; readonly run: Runner } {
  const calls: RunCall[] = [];
  return {
    calls,
    run(cmd, args) {
      calls.push({ cmd, args: [...args] });
      return Promise.resolve(result);
    },
  };
}

describe("launchd helper", () => {
  it("writes a launch agent plist and loads it", async () => {
    await withTempHome(async (homeDir) => {
      const { calls, run } = recordingRunner();
      const stateLogDir = join(homeDir, "state", "logs");
      const plistPath = launchAgentPlistPath(homeDir);

      const result = await installLaunchdAgent({
        platform: "darwin",
        homeDir,
        daemonPath: "/opt/d-env/dist/daemon/main.js",
        nodePath: "/usr/local/bin/node",
        stateLogDir,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          D_ENV_HOME: join(homeDir, "state"),
          D_ENV_MOUNT_PATH: join(homeDir, "mount"),
        },
        run,
      });

      expect(result).toEqual({
        status: "installed",
        label: LAUNCHD_LABEL,
        plistPath,
      });
      expect(calls).toEqual([{ cmd: "launchctl", args: ["load", plistPath] }]);
      expect(existsSync(stateLogDir)).toBe(true);

      const plist = readFileSync(plistPath, "utf-8");
      expect(plist).toContain("<string>com.d-env.daemon</string>");
      expect(plist).toContain("<string>/usr/local/bin/node</string>");
      expect(plist).toContain(
        "<string>/opt/d-env/dist/daemon/main.js</string>",
      );
      expect(plist).toContain("<key>RunAtLoad</key>");
      expect(plist).toContain("<key>D_ENV_HOME</key>");
      expect(plist).toContain("<key>D_ENV_MOUNT_PATH</key>");
      expect(plist).toContain("d-envd.launchd.err.log");
    });
  });

  it("unloads an existing plist before replacing it", async () => {
    await withTempHome(async (homeDir) => {
      const { calls, run } = recordingRunner();
      const plistPath = launchAgentPlistPath(homeDir);
      mkdirSync(join(homeDir, "Library", "LaunchAgents"), {
        recursive: true,
      });
      writeFileSync(plistPath, "old plist");

      await installLaunchdAgent({
        platform: "darwin",
        homeDir,
        daemonPath: "/opt/d-env/dist/daemon/main.js",
        stateLogDir: join(homeDir, "state", "logs"),
        run,
      });

      expect(calls).toEqual([
        { cmd: "launchctl", args: ["unload", plistPath] },
        { cmd: "launchctl", args: ["load", plistPath] },
      ]);
    });
  });

  it("unloads and removes the installed plist", async () => {
    await withTempHome(async (homeDir) => {
      const { calls, run } = recordingRunner();
      const plistPath = launchAgentPlistPath(homeDir);
      mkdirSync(join(homeDir, "Library", "LaunchAgents"), {
        recursive: true,
      });
      writeFileSync(plistPath, "plist");

      const result = await uninstallLaunchdAgent({
        platform: "darwin",
        homeDir,
        run,
      });

      expect(result).toEqual({
        status: "uninstalled",
        label: LAUNCHD_LABEL,
        plistPath,
      });
      expect(calls).toEqual([
        { cmd: "launchctl", args: ["unload", plistPath] },
      ]);
      expect(existsSync(plistPath)).toBe(false);
    });
  });

  it("is idempotent when uninstalling a missing plist", async () => {
    await withTempHome(async (homeDir) => {
      const { calls, run } = recordingRunner();
      const plistPath = launchAgentPlistPath(homeDir);

      await expect(
        uninstallLaunchdAgent({ platform: "darwin", homeDir, run }),
      ).resolves.toEqual({
        status: "not_installed",
        label: LAUNCHD_LABEL,
        plistPath,
      });
      expect(calls).toEqual([]);
    });
  });

  it("rejects launchd operations off macOS", async () => {
    const { run } = recordingRunner();

    await expect(
      installLaunchdAgent({
        platform: "linux",
        daemonPath: "/opt/d-env/dist/daemon/main.js",
        run,
      }),
    ).rejects.toMatchObject({
      code: "usage_error",
      message: "launchd daemon install is only supported on macOS",
    });
  });

  it("escapes plist string values", () => {
    const plist = createLaunchdPlist({
      daemonPath: "/opt/d-env/<daemon>&main.js",
      nodePath: "/usr/local/bin/node",
      stateLogDir: "/tmp/d-env & logs",
      env: { PATH: "/bin:/usr/bin & /custom" },
    });

    expect(plist).toContain("/opt/d-env/&lt;daemon&gt;&amp;main.js");
    expect(plist).toContain("/tmp/d-env &amp; logs");
    expect(plist).toContain("/bin:/usr/bin &amp; /custom");
  });
});

describe.skipIf(process.platform !== "darwin")("launchd plist on macOS", () => {
  it("generates a plist accepted by plutil", async () => {
    await withTempHome((homeDir) => {
      const plistPath = join(homeDir, "agent.plist");
      writeFileSync(
        plistPath,
        createLaunchdPlist({
          daemonPath: "/opt/d-env/dist/daemon/main.js",
          nodePath: "/usr/local/bin/node",
          stateLogDir: join(homeDir, "logs"),
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        }),
      );

      execFileSync("/usr/bin/plutil", ["-lint", plistPath], {
        stdio: "ignore",
      });
      return Promise.resolve();
    });
  });
});
