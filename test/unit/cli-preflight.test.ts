import { describe, expect, it, vi } from "vitest";
import { ensureCliPreflight } from "../../src/cli/preflight.js";
import type {
  ControlClient,
  CreateProjectResult,
  ProjectDetail,
} from "../../src/ipc/control-client.js";
import type { MountAdapter } from "../../src/mount/adapter.js";
import { EnvdError } from "../../src/shared/errors.js";

class FakeControlClient implements ControlClient {
  constructor(private readonly healthResult: "ok" | "unreachable" = "ok") {}

  health(): Promise<{ ok: boolean; version: string; uptimeSec: number }> {
    if (this.healthResult === "unreachable") {
      return Promise.reject(
        new EnvdError("daemon unreachable", { code: "daemon_unreachable" }),
      );
    }
    return Promise.resolve({ ok: true, version: "test", uptimeSec: 1 });
  }

  version(): Promise<{ cli: string | null; daemon: string; protocol: string }> {
    return Promise.reject(new Error("not needed"));
  }

  createProject(): Promise<CreateProjectResult> {
    return Promise.reject(new Error("not needed"));
  }

  getProject(): Promise<ProjectDetail> {
    return Promise.reject(new Error("not needed"));
  }

  getProjectStatus(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  getProjectDiff(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  commitProject(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  pullProject(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  deleteProject(): Promise<void> {
    return Promise.resolve();
  }

  listProviders(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  createProviderInstance(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  listProviderInstances(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  getProviderInstance(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  deleteProviderInstance(): Promise<void> {
    return Promise.resolve();
  }

  testProviderInstance(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeMountAdapter implements MountAdapter {
  readonly platform = "darwin" as const;
  mounted = false;
  mountCalls: Array<{ readonly url: string; readonly path: string }> = [];

  constructor(
    initialMounted: boolean,
    private readonly failMount = false,
  ) {
    this.mounted = initialMounted;
  }

  isMounted(): Promise<boolean> {
    return Promise.resolve(this.mounted);
  }

  mount(url: string, path: string): Promise<void> {
    this.mountCalls.push({ url, path });
    if (this.failMount) {
      return Promise.reject(new Error("mount failed"));
    }
    this.mounted = true;
    return Promise.resolve();
  }

  unmount(): Promise<void> {
    this.mounted = false;
    return Promise.resolve();
  }
}

describe("ensureCliPreflight", () => {
  it("returns a healthy existing daemon without starting it", async () => {
    const startDaemon = vi.fn<() => Promise<void>>();

    const result = await ensureCliPreflight(
      { action: "show status" },
      {
        createClient: () => new FakeControlClient(),
        startDaemon,
      },
    );

    expect(result.daemon).toBe("already_healthy");
    expect(result.mount).toEqual({ checked: false });
    expect(startDaemon).not.toHaveBeenCalled();
  });

  it("starts the daemon and waits until health succeeds", async () => {
    let createClientCalls = 0;
    const startDaemon = vi.fn(() => Promise.resolve());

    const result = await ensureCliPreflight(
      { action: "initialize project", timeoutMs: 100 },
      {
        createClient: () => {
          createClientCalls += 1;
          return new FakeControlClient(
            createClientCalls === 1 ? "unreachable" : "ok",
          );
        },
        startDaemon,
        sleep: () => Promise.resolve(),
      },
    );

    expect(result.daemon).toBe("started");
    expect(startDaemon).toHaveBeenCalledTimes(1);
  });

  it("honors noAutostart", async () => {
    await expect(
      ensureCliPreflight(
        {
          action: "initialize project",
          noAutostart: true,
        },
        {
          createClient: () => new FakeControlClient("unreachable"),
        },
      ),
    ).rejects.toMatchObject({
      code: "daemon_unreachable",
      message:
        "cannot initialize project: daemon is not running and autostart is disabled",
    });
  });

  it("times out if the daemon never becomes healthy after autostart", async () => {
    await expect(
      ensureCliPreflight(
        { action: "initialize project", timeoutMs: 0 },
        {
          createClient: () => new FakeControlClient("unreachable"),
          startDaemon: () => Promise.resolve(),
        },
      ),
    ).rejects.toMatchObject({
      code: "daemon_unreachable",
      message:
        "cannot initialize project: daemon did not become healthy within 0ms",
    });
  });

  it("mounts WebDAV when requested", async () => {
    const adapter = new FakeMountAdapter(false);

    const result = await ensureCliPreflight(
      { action: "initialize project", ensureMount: true },
      {
        createClient: () => new FakeControlClient(),
        createMountAdapter: () => Promise.resolve(adapter),
        mountPath: () => "/tmp/envd-mount",
        webdavUrl: () => "http://127.0.0.1:1911/",
      },
    );

    expect(result.mount).toEqual({
      checked: true,
      path: "/tmp/envd-mount",
      mounted: true,
    });
    expect(adapter.mountCalls).toEqual([
      { url: "http://127.0.0.1:1911/", path: "/tmp/envd-mount" },
    ]);
  });

  it("wraps mount failures with action context", async () => {
    await expect(
      ensureCliPreflight(
        { action: "initialize project", ensureMount: true },
        {
          createClient: () => new FakeControlClient(),
          createMountAdapter: () =>
            Promise.resolve(new FakeMountAdapter(false, true)),
          mountPath: () => "/tmp/envd-mount",
          webdavUrl: () => "http://127.0.0.1:1911/",
        },
      ),
    ).rejects.toMatchObject({
      code: "mount_failed",
      message: "cannot initialize project: failed to ensure mount",
      details: { path: "/tmp/envd-mount" },
    });
  });
});
