import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject, type InitResult } from "../../src/cli/commands/init.js";
import type {
  ControlClient,
  CreateProjectInput,
  CreateProjectResult,
  ProjectDetail,
} from "../../src/ipc/control-client.js";

class FakeControlClient implements ControlClient {
  private project: ProjectDetail | undefined;
  createProjectCalls = 0;

  constructor(private readonly mountTarget: string) {}

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

  createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    this.createProjectCalls += 1;
    this.project = {
      id: "project-1",
      token: "token-1",
      path: input.path,
      providerInstanceId: null,
      format: "dotenv",
      formatConfig: "{}",
      createdAt: 1,
      updatedAt: 1,
      mountPath: this.mountTarget,
    };
    return Promise.resolve({
      id: this.project.id,
      token: this.project.token,
      mountPath: this.project.mountPath,
    });
  }

  getProject(id: string): Promise<ProjectDetail> {
    if (this.project === undefined || this.project.id !== id) {
      return Promise.reject(new Error("project not found"));
    }
    return Promise.resolve(this.project);
  }

  deleteProject(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "d-env-init-test-"));
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  return fn(projectDir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("initProject", () => {
  it("registers a project, writes metadata, creates symlink, and updates gitignore", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/d-env/p/project-1.token-1/.env",
      );

      const result: InitResult = await initProject(
        projectDir,
        { yes: true },
        { client, ensureMount: false },
      );

      expect(result.status).toBe("initialized");
      expect(result.projectId).toBe("project-1");
      expect(client.createProjectCalls).toBe(1);
      expect(readJson(join(projectDir, ".d-env.json"))).toEqual({
        projectId: "project-1",
        version: 1,
      });
      expect(readlinkSync(join(projectDir, ".env"))).toBe(
        "/Volumes/d-env/p/project-1.token-1/.env",
      );
      expect(readFileSync(join(projectDir, ".gitignore"), "utf-8")).toBe(
        ".env\n",
      );
    });
  });

  it("is idempotent and recreates a missing symlink", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/d-env/p/project-1.token-1/.env",
      );
      await initProject(
        projectDir,
        { yes: true },
        { client, ensureMount: false },
      );
      unlinkSync(join(projectDir, ".env"));

      const result = await initProject(
        projectDir,
        { yes: true },
        { client, ensureMount: false },
      );

      expect(result.status).toBe("already_initialized");
      expect(client.createProjectCalls).toBe(1);
      expect(readlinkSync(join(projectDir, ".env"))).toBe(
        "/Volumes/d-env/p/project-1.token-1/.env",
      );
    });
  });

  it("does not store the project token in .d-env.json", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/d-env/p/project-1.token-1/.env",
      );

      await initProject(
        projectDir,
        { yes: true },
        { client, ensureMount: false },
      );

      const projectFile = readFileSync(
        join(projectDir, ".d-env.json"),
        "utf-8",
      );
      expect(projectFile).not.toContain("token-1");
    });
  });
});
