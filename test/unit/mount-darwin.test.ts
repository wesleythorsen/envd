import { describe, it, expect } from "vitest";
import {
  DarwinMountAdapter,
  type Runner,
  type RunResult,
  type MkdirFn,
} from "../../src/mount/darwin.js";
import { EnvdError } from "../../src/shared/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a runner that returns a fixed sequence of results in order. */
function makeRunner(results: RunResult[]): Runner {
  let idx = 0;
  // cmd and args unused: the runner is command-agnostic for unit tests.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (cmd: string, args: string[]) => {
    const result = results[idx++];
    if (result === undefined) {
      return Promise.reject(new Error("makeRunner: no more results"));
    }
    return Promise.resolve(result);
  };
}

function ok(stdout = "", stderr = ""): RunResult {
  return { stdout, stderr, code: 0 };
}

function fail(code: number, stderr = "", stdout = ""): RunResult {
  return { stdout, stderr, code };
}

/** No-op mkdir that records calls. */
function makeMkdir(): { fn: MkdirFn; calls: string[] } {
  const calls: string[] = [];
  const fn: MkdirFn = (path) => {
    calls.push(path);
    return Promise.resolve(undefined);
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// isMounted
// ---------------------------------------------------------------------------

describe("isMounted", () => {
  it("returns true when path appears in mount output", async () => {
    const mountOutput =
      "/dev/disk3s5 on /System/Volumes/Data (apfs, ...)\n" +
      "webdavfs@http://127.0.0.1:1911/ on /Volumes/envd (webdav, ...)\n";

    const adapter = new DarwinMountAdapter(makeRunner([ok(mountOutput)]));
    expect(await adapter.isMounted("/Volumes/envd")).toBe(true);
  });

  it("returns true for paths with trailing slash stripped", async () => {
    const mountOutput =
      "webdavfs@http://127.0.0.1:1911/ on /Volumes/envd (webdav, ...)\n";

    const adapter = new DarwinMountAdapter(makeRunner([ok(mountOutput)]));
    // Query with trailing slash — should still match.
    expect(await adapter.isMounted("/Volumes/envd/")).toBe(true);
  });

  it("returns false when path is not in mount output", async () => {
    const mountOutput =
      "/dev/disk3s5 on /System/Volumes/Data (apfs, ...)\n" +
      "webdavfs@http://127.0.0.1:1911/ on /Volumes/other (webdav, ...)\n";

    const adapter = new DarwinMountAdapter(makeRunner([ok(mountOutput)]));
    expect(await adapter.isMounted("/Volumes/envd")).toBe(false);
  });

  it("returns false on empty mount output", async () => {
    const adapter = new DarwinMountAdapter(makeRunner([ok("")]));
    expect(await adapter.isMounted("/Volumes/envd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

describe("mount", () => {
  it("calls mkdirFn then mount_webdav and verifies with isMounted", async () => {
    const mountOutput =
      "webdavfs@http://127.0.0.1:1911/ on /Volumes/envd-test (webdav, ...)\n";

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "/sbin/mount_webdav") return Promise.resolve(ok());
      if (cmd === "/sbin/mount") return Promise.resolve(ok(mountOutput));
      return Promise.resolve(ok());
    };

    const { fn: mkdirFn, calls: mkdirCalls } = makeMkdir();

    const adapter = new DarwinMountAdapter(runner, mkdirFn);
    await adapter.mount("http://127.0.0.1:1911/", "/Volumes/envd-test");

    // mkdirFn called with the mount path
    expect(mkdirCalls).toContain("/Volumes/envd-test");

    // mount_webdav called with correct args
    const mountCall = calls.find((c) => c.cmd === "/sbin/mount_webdav");
    expect(mountCall).toBeDefined();
    expect(mountCall?.args).toEqual([
      "-S",
      "-v",
      "envd",
      "http://127.0.0.1:1911/",
      "/Volumes/envd-test",
    ]);
  });

  it("throws EnvdError when mount_webdav exits non-zero", async () => {
    const runner: Runner = (cmd) => {
      if (cmd === "/sbin/mount_webdav")
        return Promise.resolve(fail(1, "mount error"));
      return Promise.resolve(ok());
    };

    const { fn: mkdirFn } = makeMkdir();

    const adapter = new DarwinMountAdapter(runner, mkdirFn);
    await expect(
      adapter.mount("http://127.0.0.1:1911/", "/Volumes/envd-test"),
    ).rejects.toMatchObject({ code: "mount_failed" });
  });

  it("unmounts a stale WebDAV mount for the same URL and retries on EBUSY", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let mountWebdavCalls = 0;
    let mountCalls = 0;
    const runner: Runner = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "/sbin/mount_webdav") {
        mountWebdavCalls++;
        return Promise.resolve(mountWebdavCalls === 1 ? fail(16) : ok());
      }
      if (cmd === "/sbin/mount") {
        mountCalls++;
        return Promise.resolve(
          mountCalls === 1
            ? ok(
                "http://127.0.0.1:1911/ on /Users/me/.envd/mount (webdav, ...)\n",
              )
            : ok(
                "http://127.0.0.1:1911/ on /Users/me/.local/state/envd/run/mount (webdav, ...)\n",
              ),
        );
      }
      return Promise.resolve(ok());
    };

    const { fn: mkdirFn } = makeMkdir();
    const adapter = new DarwinMountAdapter(runner, mkdirFn);

    await adapter.mount(
      "http://127.0.0.1:1911/",
      "/Users/me/.local/state/envd/run/mount",
    );

    expect(calls.map((call) => call.cmd)).toEqual([
      "/sbin/mount_webdav",
      "/sbin/mount",
      "/sbin/umount",
      "/sbin/mount_webdav",
      "/sbin/mount",
    ]);
    expect(calls[2]?.args).toEqual(["/Users/me/.envd/mount"]);
  });

  it("throws EnvdError when mount_webdav succeeds but path is not mounted", async () => {
    // mount_webdav returns 0 but isMounted check returns false (empty mount list)
    const runner: Runner = (cmd) => {
      if (cmd === "/sbin/mount_webdav") return Promise.resolve(ok());
      if (cmd === "/sbin/mount") return Promise.resolve(ok("")); // empty — nothing mounted
      return Promise.resolve(ok());
    };

    const { fn: mkdirFn } = makeMkdir();

    const adapter = new DarwinMountAdapter(runner, mkdirFn);
    await expect(
      adapter.mount("http://127.0.0.1:1911/", "/Volumes/envd-test"),
    ).rejects.toMatchObject({ code: "mount_failed" });
  });
});

// ---------------------------------------------------------------------------
// unmount
// ---------------------------------------------------------------------------

describe("unmount", () => {
  it("calls umount and resolves on success", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(ok());
    };

    const adapter = new DarwinMountAdapter(runner);
    await adapter.unmount("/Volumes/envd-test");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cmd: "/sbin/umount",
      args: ["/Volumes/envd-test"],
    });
  });

  it("retries on EBUSY (exit code 16) and resolves when retry succeeds", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let callCount = 0;
    const runner: Runner = (cmd, args) => {
      calls.push({ cmd, args });
      callCount++;
      if (callCount === 1) return Promise.resolve(fail(16, "Resource busy"));
      return Promise.resolve(ok());
    };

    const adapter = new DarwinMountAdapter(runner);
    await adapter.unmount("/Volumes/envd-test");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.cmd).toBe("/sbin/umount");
    expect(calls[1]?.cmd).toBe("/sbin/umount");
  });

  it("retries when stderr contains 'Resource busy' and resolves when retry succeeds", async () => {
    let callCount = 0;
    const runner: Runner = () => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          fail(1, "umount: Resource busy -- try 'diskutil unmount'"),
        );
      }
      return Promise.resolve(ok());
    };

    const adapter = new DarwinMountAdapter(runner);
    await adapter.unmount("/Volumes/envd-test");
    expect(callCount).toBe(2);
  });

  it("throws EnvdError after retry still fails on EBUSY", async () => {
    const runner: Runner = () => Promise.resolve(fail(16, "Resource busy"));

    const adapter = new DarwinMountAdapter(runner);
    await expect(adapter.unmount("/Volumes/envd-test")).rejects.toMatchObject({
      code: "mount_failed",
    });
  });

  it("throws EnvdError immediately on non-EBUSY failure", async () => {
    const runner: Runner = () =>
      Promise.resolve(fail(1, "no such file or directory"));

    const adapter = new DarwinMountAdapter(runner);
    await expect(adapter.unmount("/Volumes/envd-test")).rejects.toBeInstanceOf(
      EnvdError,
    );
  });
});
