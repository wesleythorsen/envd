import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LaunchdInstallOptions,
  LaunchdInstallResult,
  LaunchdUninstallResult,
} from "../../src/cli/launchd.js";

const { fetchMock } = vi.hoisted(() => {
  return {
    fetchMock: vi.fn(),
  };
});

vi.mock("undici", () => {
  return { fetch: fetchMock };
});

async function loadDaemonModule(): Promise<
  typeof import("../../src/cli/commands/daemon.js")
> {
  vi.resetModules();
  return import("../../src/cli/commands/daemon.js");
}

function withTempState(fn: () => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "d-env-daemon-command-test-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "ports.json"),
    JSON.stringify({ control: 1910, webdav: 2910 }),
  );
  writeFileSync(join(home, "control-token"), "token-1\n");
  process.env["D_ENV_HOME"] = home;

  return fn().finally(() => {
    delete process.env["D_ENV_HOME"];
    rmSync(home, { recursive: true, force: true });
  });
}

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
});

describe("readDaemonLogs", () => {
  it("prints JSON log tail lines returned by the control API", async () => {
    await withTempState(async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ lines: ["one\n", "two\n"] }),
      });

      const { readDaemonLogs } = await loadDaemonModule();
      let stdout = "";
      await readDaemonLogs(
        { tail: "2" },
        {
          stdout: {
            write(chunk: string) {
              stdout += chunk;
              return true;
            },
          },
        },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:1910/v1/logs?tail=2",
        {
          headers: { Authorization: "Bearer token-1" },
        },
      );
      expect(stdout).toBe("one\ntwo\n");
    });
  });

  it("parses followed SSE log events even when chunk boundaries split events", async () => {
    await withTempState(async () => {
      const chunks = [
        Buffer.from('data: {"line":"seed\\n"}\n\n' + 'data: {"line":"live'),
        Buffer.from('\\n"}\n\n'),
      ];
      fetchMock.mockResolvedValue({
        ok: true,
        body: {
          getReader() {
            return {
              read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: chunks[0] })
                .mockResolvedValueOnce({ done: false, value: chunks[1] })
                .mockResolvedValue({ done: true, value: undefined }),
            };
          },
        },
      });

      const { readDaemonLogs } = await loadDaemonModule();
      let stdout = "";
      await readDaemonLogs(
        { tail: "0", follow: true },
        {
          stdout: {
            write(chunk: string) {
              stdout += chunk;
              return true;
            },
          },
        },
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:1910/v1/logs?tail=0&follow=true",
        {
          headers: { Authorization: "Bearer token-1" },
        },
      );
      expect(stdout).toBe("seed\nlive\n");
    });
  });

  it("rejects a negative tail value before making a request", async () => {
    await withTempState(async () => {
      const { readDaemonLogs } = await loadDaemonModule();
      await expect(readDaemonLogs({ tail: "-1" })).rejects.toMatchObject({
        code: "usage_error",
        message: "tail must be a non-negative integer",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("daemon logs command", () => {
  it("wires the logs subcommand through the injected streams", async () => {
    await withTempState(async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ lines: ["tail\n"] }),
      });

      const { buildDaemonCommand } = await loadDaemonModule();
      let stdout = "";
      const command = buildDaemonCommand({
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        },
      });

      await command.parseAsync(["logs", "--tail", "1"], { from: "user" });
      expect(stdout).toBe("tail\n");
    });
  });
});

function parseJsonOutput(stdout: string): unknown {
  return JSON.parse(stdout) as unknown;
}

describe("daemon command launchd wiring", () => {
  it("passes the resolved daemon path to launchd install", async () => {
    let stdout = "";
    let installOptions: LaunchdInstallOptions | undefined;
    const installResult: LaunchdInstallResult = {
      status: "installed",
      label: "com.d-env.daemon",
      plistPath: "/Users/test/Library/LaunchAgents/com.d-env.daemon.plist",
    };

    const { buildDaemonCommand } = await loadDaemonModule();
    const command = buildDaemonCommand({
      resolveDaemonPath: () => "/repo/dist/daemon/main.js",
      installLaunchdAgent(opts) {
        installOptions = opts;
        return Promise.resolve(installResult);
      },
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
    });

    await command.parseAsync(["install", "--json"], { from: "user" });

    expect(installOptions).toEqual({
      daemonPath: "/repo/dist/daemon/main.js",
    });
    expect(parseJsonOutput(stdout)).toEqual(installResult);
  });

  it("wires daemon uninstall to the launchd helper", async () => {
    let stdout = "";
    let uninstallCalls = 0;
    const uninstallResult: LaunchdUninstallResult = {
      status: "uninstalled",
      label: "com.d-env.daemon",
      plistPath: "/Users/test/Library/LaunchAgents/com.d-env.daemon.plist",
    };

    const { buildDaemonCommand } = await loadDaemonModule();
    const command = buildDaemonCommand({
      uninstallLaunchdAgent() {
        uninstallCalls += 1;
        return Promise.resolve(uninstallResult);
      },
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
    });

    await command.parseAsync(["uninstall", "--json"], { from: "user" });

    expect(uninstallCalls).toBe(1);
    expect(parseJsonOutput(stdout)).toEqual(uninstallResult);
  });
});
