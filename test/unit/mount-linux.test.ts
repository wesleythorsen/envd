import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import {
  LinuxMountAdapter,
  type Runner,
  type RunResult,
  type MkdirFn,
  type MkdtempFn,
  type WriteFileFn,
  type RemoveFn,
} from "../../src/mount/linux.js";

function ok(stdout = "", stderr = ""): RunResult {
  return { stdout, stderr, code: 0 };
}

function fail(code: number, stderr = "", stdout = ""): RunResult {
  return { stdout, stderr, code };
}

function makeMkdir(): { fn: MkdirFn; calls: string[] } {
  const calls: string[] = [];
  const fn: MkdirFn = (path) => {
    calls.push(path);
    return Promise.resolve(undefined);
  };
  return { fn, calls };
}

function makeMkdtemp(): { fn: MkdtempFn; dirs: string[] } {
  const dirs: string[] = [];
  const fn: MkdtempFn = (prefix) => {
    const dir = `${prefix}fixture`;
    dirs.push(dir);
    return Promise.resolve(dir);
  };
  return { fn, dirs };
}

function makeWriteFile(): {
  fn: WriteFileFn;
  calls: Array<{ path: string; data: string }>;
} {
  const calls: Array<{ path: string; data: string }> = [];
  const fn: WriteFileFn = (path, data) => {
    calls.push({ path, data });
    return Promise.resolve();
  };
  return { fn, calls };
}

function makeRemove(): {
  fn: RemoveFn;
  calls: string[];
} {
  const calls: string[] = [];
  const fn: RemoveFn = (path) => {
    calls.push(path);
    return Promise.resolve();
  };
  return { fn, calls };
}

describe("LinuxMountAdapter", () => {
  const configDir = `${tmpdir()}/envd-davfs2-fixture`;
  const configPath = `${configDir}/davfs2.conf`;

  it("detects an active mount point from linux mount output", async () => {
    const mountOutput =
      "tmpfs on /run type tmpfs (rw,nosuid,nodev)\n" +
      "http://127.0.0.1:1911/ on /home/user/.envd/mount type fuse.davfs (rw,nodev)\n";
    const runner: Runner = (cmd) => {
      if (cmd === "mount") {
        return Promise.resolve(ok(mountOutput));
      }
      return Promise.resolve(ok());
    };

    const adapter = new LinuxMountAdapter(runner);
    expect(await adapter.isMounted("/home/user/.envd/mount/")).toBe(true);
  });

  it("mounts with a temporary davfs2 config that disables locks", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: Runner = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "mount") {
        return Promise.resolve(
          ok(
            "http://127.0.0.1:1911/ on /tmp/envd-mount type fuse.davfs (rw,nodev)\n",
          ),
        );
      }
      return Promise.resolve(ok());
    };
    const { fn: mkdirFn, calls: mkdirCalls } = makeMkdir();
    const { fn: mkdtempFn } = makeMkdtemp();
    const { fn: writeFileFn, calls: writeCalls } = makeWriteFile();

    const adapter = new LinuxMountAdapter(
      runner,
      mkdirFn,
      mkdtempFn,
      writeFileFn,
    );
    await adapter.mount("http://127.0.0.1:1911/", "/tmp/envd-mount");

    expect(mkdirCalls).toEqual(["/tmp/envd-mount"]);
    expect(writeCalls).toEqual([
      {
        path: configPath,
        data: "use_locks 0\n",
      },
    ]);
    expect(calls).toEqual([
      { cmd: "mount.davfs", args: ["-V"] },
      {
        cmd: "mount.davfs",
        args: [
          "-o",
          `conf=${configPath}`,
          "http://127.0.0.1:1911/",
          "/tmp/envd-mount",
        ],
      },
      { cmd: "mount", args: [] },
    ]);
  });

  it("throws a mount_failed error with an install hint when davfs2 is missing", async () => {
    const runner: Runner = () =>
      Promise.resolve(fail(127, "mount.davfs: not found"));
    const adapter = new LinuxMountAdapter(runner);

    await expect(
      adapter.mount("http://127.0.0.1:1911/", "/tmp/envd-mount"),
    ).rejects.toMatchObject({
      code: "mount_failed",
      message:
        "install davfs2 first (apt install davfs2 or dnf install davfs2)",
    });
  });

  it("cleans up the temporary config directory after unmount", async () => {
    let mounted = false;
    const runner: Runner = (cmd) => {
      if (cmd === "mount") {
        return Promise.resolve(
          ok(
            mounted
              ? "http://127.0.0.1:1911/ on /tmp/envd-mount type fuse.davfs (rw,nodev)\n"
              : "",
          ),
        );
      }
      if (cmd === "umount") {
        mounted = false;
        return Promise.resolve(ok());
      }
      if (cmd === "mount.davfs") {
        mounted = true;
        return Promise.resolve(ok());
      }
      return Promise.resolve(ok());
    };
    const { fn: mkdtempFn } = makeMkdtemp();
    const { fn: writeFileFn } = makeWriteFile();
    const { fn: removeFn, calls: removeCalls } = makeRemove();

    const adapter = new LinuxMountAdapter(
      runner,
      makeMkdir().fn,
      mkdtempFn,
      writeFileFn,
      removeFn,
    );
    await adapter.mount("http://127.0.0.1:1911/", "/tmp/envd-mount");
    await adapter.unmount("/tmp/envd-mount");

    expect(removeCalls).toEqual([configDir]);
  });
});
