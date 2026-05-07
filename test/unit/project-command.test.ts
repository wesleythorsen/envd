import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { moveProjectProvider } from "../../src/cli/commands/project.js";
import type { ControlClient } from "../../src/ipc/control-client.js";
import { readEnvdConfig, registerProject } from "../../src/cli/config-file.js";

function fakeClient(): ControlClient & {
  readonly moveCalls: Array<{
    readonly id: string;
    readonly provider: string;
    readonly purge: boolean | undefined;
  }>;
} {
  const moveCalls: Array<{
    readonly id: string;
    readonly provider: string;
    readonly purge: boolean | undefined;
  }> = [];
  return {
    moveCalls,
    health: () => Promise.resolve({ ok: true, version: "test", uptimeSec: 0 }),
    version: () =>
      Promise.resolve({ cli: null, daemon: "test", protocol: "v1" }),
    createProject: () => Promise.reject(new Error("not needed")),
    getProject: () => Promise.reject(new Error("not needed")),
    listProjectEnvironments: () => Promise.reject(new Error("not needed")),
    createProjectEnvironment: () => Promise.reject(new Error("not needed")),
    setProjectActiveEnvironment: () => Promise.reject(new Error("not needed")),
    importProjectEnvironment: () => Promise.reject(new Error("not needed")),
    moveProjectProvider: (id, input) => {
      moveCalls.push({ id, provider: input.provider, purge: input.purge });
      return Promise.resolve({
        projectId: id,
        providerInstanceId: "target-provider",
        movedEnvironments: ["default", "dev"],
        purged: input.purge === true,
      });
    },
    getProjectStatus: () => Promise.reject(new Error("not needed")),
    getProjectDiff: () => Promise.reject(new Error("not needed")),
    commitProject: () => Promise.reject(new Error("not needed")),
    pullProject: () => Promise.reject(new Error("not needed")),
    deleteProject: () => Promise.resolve(),
    listProviders: () => Promise.resolve([]),
    createProviderInstance: () => Promise.reject(new Error("not needed")),
    listProviderInstances: () => Promise.resolve([]),
    getProviderInstance: () => Promise.reject(new Error("not needed")),
    deleteProviderInstance: () => Promise.resolve(),
    testProviderInstance: () => Promise.resolve({ ok: true }),
    shutdown: () => Promise.resolve(),
  };
}

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "envd-project-command-"));
  mkdirSync(join(dir, "project"));
  const projectDir = realpathSync.native(join(dir, "project"));
  const previousHome = process.env["ENVD_HOME"];
  process.env["ENVD_HOME"] = dir;
  return fn(projectDir).finally(() => {
    if (previousHome === undefined) {
      delete process.env["ENVD_HOME"];
    } else {
      process.env["ENVD_HOME"] = previousHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("project command helpers", () => {
  it("moves the current project provider and updates local registration", async () => {
    await withTempProject(async (projectDir) => {
      registerProject({
        id: "project-1",
        root: projectDir,
        providerInstanceId: "source-provider",
        activeEnvironment: "default",
        environments: [{ name: "default", providerEnvironment: "default" }],
      });
      const client = fakeClient();

      const result = await moveProjectProvider(
        projectDir,
        { provider: "target", purge: true },
        { client },
      );

      expect(result.providerInstanceId).toBe("target-provider");
      expect(client.moveCalls).toEqual([
        { id: "project-1", provider: "target", purge: true },
      ]);
      expect(readEnvdConfig().projects[0]?.providerInstanceId).toBe(
        "target-provider",
      );
    });
  });
});
