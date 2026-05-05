import { describe, expect, it } from "vitest";
import {
  SYSTEMD_USER_SERVICE_NAME,
  buildSystemdUserUnit,
  installSystemdUserService,
  quoteSystemdExecArg,
  systemdUserServicePath,
  uninstallSystemdUserService,
  type MkdirFn,
  type RemoveFn,
  type RunResult,
  type SystemdRunner,
  type WriteFileFn,
} from "../../src/cli/systemd-user.js";

function ok(stdout = "", stderr = ""): RunResult {
  return { stdout, stderr, code: 0 };
}

function fail(code: number, stderr = "", stdout = ""): RunResult {
  return { stdout, stderr, code };
}

function makeSystemctlRunner(): {
  readonly fn: SystemdRunner;
  readonly calls: string[][];
} {
  const calls: string[][] = [];
  const fn: SystemdRunner = (args) => {
    calls.push([...args]);
    return Promise.resolve(ok());
  };
  return { fn, calls };
}

function makeMkdir(): { readonly fn: MkdirFn; readonly calls: string[] } {
  const calls: string[] = [];
  const fn: MkdirFn = (path) => {
    calls.push(path);
    return Promise.resolve(undefined);
  };
  return { fn, calls };
}

function makeWriteFile(): {
  readonly fn: WriteFileFn;
  readonly calls: Array<{
    readonly path: string;
    readonly data: string;
    readonly mode: number;
  }>;
} {
  const calls: Array<{
    readonly path: string;
    readonly data: string;
    readonly mode: number;
  }> = [];
  const fn: WriteFileFn = (path, data, opts) => {
    calls.push({ path, data, mode: opts.mode });
    return Promise.resolve();
  };
  return { fn, calls };
}

function makeRemove(): { readonly fn: RemoveFn; readonly calls: string[] } {
  const calls: string[] = [];
  const fn: RemoveFn = (path) => {
    calls.push(path);
    return Promise.resolve();
  };
  return { fn, calls };
}

describe("systemd user service helpers", () => {
  it("returns the standard user unit path", () => {
    expect(systemdUserServicePath("/home/alice")).toBe(
      `/home/alice/.config/systemd/user/${SYSTEMD_USER_SERVICE_NAME}`,
    );
  });

  it("builds a systemd unit that starts envdd with node", () => {
    expect(
      buildSystemdUserUnit({
        nodePath: "/usr/bin/node",
        daemonPath: "/opt/envd/dist/daemon/main.js",
      }),
    ).toBe(
      [
        "[Unit]",
        "Description=envd daemon",
        "",
        "[Service]",
        "Type=simple",
        "ExecStart=/usr/bin/node /opt/envd/dist/daemon/main.js",
        "Restart=on-failure",
        "RestartSec=2s",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
  });

  it("quotes ExecStart arguments with spaces and escapes systemd percent specifiers", () => {
    expect(quoteSystemdExecArg('/opt/d env/%daemon"main.js')).toBe(
      '"/opt/d env/%%daemon\\"main.js"',
    );
  });

  it("installs, enables, and starts the systemd user service on linux", async () => {
    const systemctl = makeSystemctlRunner();
    const mkdir = makeMkdir();
    const write = makeWriteFile();

    const result = await installSystemdUserService({
      platform: "linux",
      homeDir: "/home/alice",
      nodePath: "/usr/bin/node",
      daemonPath: "/opt/envd/dist/daemon/main.js",
      runSystemctl: systemctl.fn,
      mkdirFn: mkdir.fn,
      writeFileFn: write.fn,
    });

    expect(result).toEqual({
      status: "installed",
      serviceName: SYSTEMD_USER_SERVICE_NAME,
      unitPath: `/home/alice/.config/systemd/user/${SYSTEMD_USER_SERVICE_NAME}`,
    });
    expect(mkdir.calls).toEqual(["/home/alice/.config/systemd/user"]);
    expect(write.calls).toHaveLength(1);
    expect(write.calls[0]).toMatchObject({
      path: `/home/alice/.config/systemd/user/${SYSTEMD_USER_SERVICE_NAME}`,
      mode: 0o644,
    });
    expect(write.calls[0]?.data).toContain(
      "ExecStart=/usr/bin/node /opt/envd/dist/daemon/main.js\n",
    );
    expect(systemctl.calls).toEqual([
      ["daemon-reload"],
      ["enable", SYSTEMD_USER_SERVICE_NAME],
      ["start", SYSTEMD_USER_SERVICE_NAME],
    ]);
  });

  it("resolves the daemon path lazily after the linux platform gate", async () => {
    let resolved = false;

    await expect(
      installSystemdUserService({
        platform: "darwin",
        daemonPath: () => {
          resolved = true;
          return "/opt/envd/dist/daemon/main.js";
        },
      }),
    ).rejects.toMatchObject({
      code: "usage_error",
      message: "systemd --user daemon install is only supported on linux",
    });
    expect(resolved).toBe(false);
  });

  it("disables, stops, removes, and reloads the systemd user service on linux", async () => {
    const systemctl = makeSystemctlRunner();
    const remove = makeRemove();

    const result = await uninstallSystemdUserService({
      platform: "linux",
      homeDir: "/home/alice",
      runSystemctl: systemctl.fn,
      removeFn: remove.fn,
    });

    expect(result).toEqual({
      status: "uninstalled",
      serviceName: SYSTEMD_USER_SERVICE_NAME,
      unitPath: `/home/alice/.config/systemd/user/${SYSTEMD_USER_SERVICE_NAME}`,
    });
    expect(systemctl.calls).toEqual([
      ["disable", SYSTEMD_USER_SERVICE_NAME],
      ["stop", SYSTEMD_USER_SERVICE_NAME],
      ["daemon-reload"],
    ]);
    expect(remove.calls).toEqual([
      `/home/alice/.config/systemd/user/${SYSTEMD_USER_SERVICE_NAME}`,
    ]);
  });

  it("rejects uninstall on non-linux platforms before systemctl calls", async () => {
    const systemctl = makeSystemctlRunner();

    await expect(
      uninstallSystemdUserService({
        platform: "darwin",
        runSystemctl: systemctl.fn,
      }),
    ).rejects.toMatchObject({
      code: "usage_error",
      message: "systemd --user daemon install is only supported on linux",
    });
    expect(systemctl.calls).toEqual([]);
  });

  it("raises a EnvdError when systemctl fails", async () => {
    const systemctl: SystemdRunner = (args) => {
      if (args[0] === "enable") {
        return Promise.resolve(fail(1, "no user bus"));
      }
      return Promise.resolve(ok());
    };

    await expect(
      installSystemdUserService({
        platform: "linux",
        homeDir: "/home/alice",
        nodePath: "/usr/bin/node",
        daemonPath: "/opt/envd/dist/daemon/main.js",
        runSystemctl: systemctl,
        mkdirFn: makeMkdir().fn,
        writeFileFn: makeWriteFile().fn,
      }),
    ).rejects.toMatchObject({
      code: "internal",
      message: `systemctl --user enable ${SYSTEMD_USER_SERVICE_NAME} failed: no user bus`,
    });
  });
});
