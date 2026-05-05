import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linkProject } from "../../src/cli/commands/link.js";
import { unlinkProject } from "../../src/cli/commands/unlink.js";
import type {
  ControlClient,
  CreateProjectResult,
  ProjectDetail,
} from "../../src/ipc/control-client.js";
import { DEnvError } from "../../src/shared/errors.js";

class FakeControlClient implements ControlClient {
  deletedProjectIds: string[] = [];

  constructor(private readonly project: ProjectDetail | null) {}

  health(): Promise<{ ok: boolean; version: string; uptimeSec: number }> {
    return Promise.resolve({ ok: true, version: "test", uptimeSec: 0 });
  }

  version(): Promise<{
    cli: string | null;
    daemon: string;
    protocol: string;
  }> {
    return Promise.resolve({ cli: null, daemon: "test", protocol: "v1" });
  }

  createProject(): Promise<CreateProjectResult> {
    return Promise.reject(new Error("not needed"));
  }

  getProject(id: string): Promise<ProjectDetail> {
    if (this.project === null || this.project.id !== id) {
      return Promise.reject(
        new DEnvError("Project not found", { code: "not_found" }),
      );
    }
    return Promise.resolve(this.project);
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

  deleteProject(id: string): Promise<void> {
    this.deletedProjectIds.push(id);
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "d-env-link-test-"));
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  return fn(projectDir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function writeProjectFile(projectDir: string): void {
  writeFileSync(
    join(projectDir, ".d-env.json"),
    JSON.stringify({ projectId: "project-1", version: 1 }),
  );
}

function projectDetail(projectDir: string): ProjectDetail {
  return {
    id: "project-1",
    token: "token-1",
    path: projectDir,
    providerInstanceId: null,
    format: "dotenv",
    formatConfig: "{}",
    createdAt: 1,
    updatedAt: 1,
    mountPath: "/tmp/d-env-mount/p/project-1.token-1/.env",
  };
}

describe("linkProject", () => {
  it("recreates the .env symlink from an existing .d-env.json", async () => {
    await withTempProject(async (projectDir) => {
      writeProjectFile(projectDir);
      const client = new FakeControlClient(projectDetail(projectDir));

      const result = await linkProject(projectDir, { client });

      expect(result).toEqual({
        status: "linked",
        projectId: "project-1",
        envPath: join(projectDir, ".env"),
        symlinkTarget: "/tmp/d-env-mount/p/project-1.token-1/.env",
      });
      expect(readlinkSync(join(projectDir, ".env"))).toBe(
        "/tmp/d-env-mount/p/project-1.token-1/.env",
      );
    });
  });

  it("errors with re-init guidance when the daemon does not know the project", async () => {
    await withTempProject(async (projectDir) => {
      writeProjectFile(projectDir);
      const client = new FakeControlClient(null);

      await expect(linkProject(projectDir, { client })).rejects.toMatchObject({
        code: "not_initialized",
      });
    });
  });
});

describe("unlinkProject", () => {
  it("removes the .env symlink without purging by default", async () => {
    await withTempProject(async (projectDir) => {
      writeProjectFile(projectDir);
      symlinkSync(
        "/tmp/d-env-mount/p/project-1.token-1/.env",
        join(projectDir, ".env"),
      );
      const client = new FakeControlClient(projectDetail(projectDir));

      const result = await unlinkProject(
        projectDir,
        { purge: false },
        { client },
      );

      expect(result).toEqual({
        status: "unlinked",
        projectId: "project-1",
        envPath: join(projectDir, ".env"),
        removedSymlink: true,
        purged: false,
      });
      expect(existsSync(join(projectDir, ".env"))).toBe(false);
      expect(client.deletedProjectIds).toEqual([]);
    });
  });

  it("purges the daemon registry when --purge is set", async () => {
    await withTempProject(async (projectDir) => {
      writeProjectFile(projectDir);
      symlinkSync(
        "/tmp/d-env-mount/p/project-1.token-1/.env",
        join(projectDir, ".env"),
      );
      const client = new FakeControlClient(projectDetail(projectDir));

      const result = await unlinkProject(
        projectDir,
        { purge: true },
        { client },
      );

      expect(result.purged).toBe(true);
      expect(client.deletedProjectIds).toEqual(["project-1"]);
    });
  });
});
