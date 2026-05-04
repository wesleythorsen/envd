import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStatus } from "../../src/cli/commands/status.js";
import type {
  ControlClient,
  ProjectDetail,
} from "../../src/ipc/control-client.js";
import type { MountAdapter } from "../../src/mount/adapter.js";
import { DEnvError } from "../../src/shared/errors.js";

class FakeControlClient implements ControlClient {
  constructor(private readonly project: ProjectDetail | null = null) {}

  health(): Promise<{ ok: boolean; version: string; uptimeSec: number }> {
    return Promise.resolve({ ok: true, version: "test", uptimeSec: 12 });
  }

  version(): Promise<{
    cli: string | null;
    daemon: string;
    protocol: string;
  }> {
    return Promise.resolve({ cli: null, daemon: "test", protocol: "v1" });
  }

  createProject(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  deleteProject(): Promise<void> {
    return Promise.resolve();
  }

  getProject(id: string): Promise<ProjectDetail> {
    if (this.project === null || this.project.id !== id) {
      return Promise.reject(new Error("not found"));
    }
    return Promise.resolve(this.project);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeMountAdapter implements MountAdapter {
  readonly platform = "darwin" as const;

  constructor(private readonly mounted: boolean) {}

  isMounted(): Promise<boolean> {
    return Promise.resolve(this.mounted);
  }

  mount(): Promise<void> {
    return Promise.resolve();
  }

  unmount(): Promise<void> {
    return Promise.resolve();
  }
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "d-env-status-test-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("getStatus", () => {
  it("reports daemon and mount status without a project context", async () => {
    await withTempDir(async (dir) => {
      const status = await getStatus({
        projectPath: dir,
        client: new FakeControlClient(),
        mountAdapter: new FakeMountAdapter(true),
      });

      expect(status.daemon).toEqual({
        running: true,
        version: "test",
        uptimeSec: 12,
        error: null,
      });
      expect(status.mount.mounted).toBe(true);
      expect(status.project).toBeNull();
    });
  });

  it("adds project details inside an initialized directory", async () => {
    await withTempDir(async (dir) => {
      const envTarget = "/tmp/d-env-mount/p/project-1.token-1/.env";
      writeFileSync(
        join(dir, ".d-env.json"),
        JSON.stringify({ projectId: "project-1", version: 1 }),
      );
      symlinkSync(envTarget, join(dir, ".env"));

      const project: ProjectDetail = {
        id: "project-1",
        token: "token-1",
        path: dir,
        format: "dotenv",
        formatConfig: "{}",
        createdAt: 1,
        updatedAt: 1,
        mountPath: envTarget,
      };

      const status = await getStatus({
        projectPath: dir,
        client: new FakeControlClient(project),
        mountAdapter: new FakeMountAdapter(false),
      });

      expect(status.mount.mounted).toBe(false);
      expect(status.project).toEqual({
        path: dir,
        projectId: "project-1",
        envPath: join(dir, ".env"),
        symlinkTarget: envTarget,
        registered: true,
        lastFetchTime: null,
      });
    });
  });

  it("reports daemon unreachable without throwing", async () => {
    await withTempDir(async (dir) => {
      const status = await getStatus({
        projectPath: dir,
        createClient: () => {
          throw new DEnvError("no daemon", { code: "daemon_unreachable" });
        },
        mountAdapter: new FakeMountAdapter(false),
      });

      expect(status.daemon.running).toBe(false);
      expect(status.project).toBeNull();
    });
  });
});
