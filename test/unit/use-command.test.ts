import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useEnvironment } from "../../src/cli/commands/use.js";
import type {
  ControlClient,
  ProjectDetail,
  ProjectDiffOptions,
  ProjectDiffResult,
  ProjectEnvironmentDetail,
} from "../../src/ipc/control-client.js";
import { EnvdError } from "../../src/shared/errors.js";
import { readEnvdConfig, registerProject } from "../../src/cli/config-file.js";

interface FakeClientOptions {
  readonly environments?: readonly ProjectEnvironmentDetail[];
  readonly diffs?: ReadonlyMap<string, ProjectDiffResult>;
}

function projectDetail(activeEnvironment: string): ProjectDetail {
  return {
    id: "project-1",
    token: "token",
    path: "/tmp/project",
    providerInstanceId: "provider-1",
    activeEnvironment,
    format: "dotenv",
    formatConfig: "{}",
    createdAt: 1,
    updatedAt: 2,
    mountPath: `/tmp/envd-mount/p/project-1/${activeEnvironment}/.env`,
  };
}

function environment(
  name: string,
  providerEnvironment = name,
): ProjectEnvironmentDetail {
  return {
    projectId: "project-1",
    name,
    providerEnvironment,
    createdAt: 1,
    updatedAt: 2,
  };
}

function emptyDiff(): ProjectDiffResult {
  return { keys: { added: [], modified: [], deleted: [] } };
}

function fakeClient(opts: FakeClientOptions = {}): ControlClient & {
  readonly createEnvironmentCalls: Array<{
    readonly id: string;
    readonly name: string;
    readonly providerEnvironment: string | undefined;
  }>;
  readonly diffCalls: Array<{
    readonly id: string;
    readonly opts?: ProjectDiffOptions;
  }>;
  readonly setActiveCalls: Array<{
    readonly id: string;
    readonly name: string;
  }>;
} {
  const environments = [
    ...(opts.environments ?? [environment("default"), environment("dev")]),
  ];
  const createEnvironmentCalls: Array<{
    readonly id: string;
    readonly name: string;
    readonly providerEnvironment: string | undefined;
  }> = [];
  const diffCalls: Array<{
    readonly id: string;
    readonly opts?: ProjectDiffOptions;
  }> = [];
  const setActiveCalls: Array<{ readonly id: string; readonly name: string }> =
    [];

  return {
    createEnvironmentCalls,
    diffCalls,
    setActiveCalls,
    health: () => Promise.resolve({ ok: true, version: "test", uptimeSec: 0 }),
    version: () =>
      Promise.resolve({ cli: null, daemon: "test", protocol: "v1" }),
    createProject: () => Promise.reject(new Error("not needed")),
    getProject: (id) =>
      Promise.resolve({
        ...projectDetail("default"),
        id,
        mountPath: "/tmp/envd-mount/p/project-1/default/.env",
      }),
    listProjectEnvironments: () => Promise.resolve(environments),
    createProjectEnvironment: (id, input) => {
      createEnvironmentCalls.push({
        id,
        name: input.name,
        providerEnvironment: input.providerEnvironment,
      });
      const created = environment(
        input.name,
        input.providerEnvironment ?? input.name,
      );
      environments.push(created);
      return Promise.resolve(created);
    },
    setProjectActiveEnvironment: (id, name) => {
      setActiveCalls.push({ id, name });
      return Promise.resolve(projectDetail(name));
    },
    importProjectEnvironment: () => Promise.reject(new Error("not needed")),
    moveProjectProvider: () => Promise.reject(new Error("not needed")),
    getProjectStatus: () => Promise.reject(new Error("not needed")),
    getProjectDiff: (id, diffOpts) => {
      diffCalls.push({
        id,
        ...(diffOpts === undefined ? {} : { opts: diffOpts }),
      });
      return Promise.resolve(
        opts.diffs?.get(diffOpts?.environment ?? "") ?? emptyDiff(),
      );
    },
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
  const dir = mkdtempSync(join(tmpdir(), "envd-use-command-"));
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

function registerTestProject(projectDir: string): void {
  registerProject({
    id: "project-1",
    root: projectDir,
    providerInstanceId: "provider-1",
    activeEnvironment: "default",
    environments: [
      { name: "default", providerEnvironment: "default" },
      { name: "dev", providerEnvironment: "dev" },
    ],
  });
}

describe("use command helpers", () => {
  it("switches directly, updates local config, and refreshes the .env symlink", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const client = fakeClient();

      const result = await useEnvironment(
        "dev",
        { path: projectDir },
        { client },
      );

      expect(result.activeEnvironment).toBe("dev");
      expect(client.setActiveCalls).toEqual([{ id: "project-1", name: "dev" }]);
      expect(readEnvdConfig().projects[0]?.activeEnvironment).toBe("dev");
      expect(readlinkSync(join(projectDir, ".env"))).toBe(
        "/tmp/envd-mount/p/project-1/dev/.env",
      );
    });
  });

  it("opens an interactive selector when no environment is provided", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const client = fakeClient();
      let stdout = "";

      const result = await useEnvironment(
        undefined,
        { path: projectDir },
        {
          client,
          prompt: () => Promise.resolve("2"),
          stdout: {
            write(chunk: string) {
              stdout += chunk;
              return true;
            },
          },
        },
      );

      expect(result.activeEnvironment).toBe("dev");
      expect(stdout).toContain("Select environment:");
      expect(stdout).toContain("1. default *");
      expect(stdout).toContain("2. dev");
    });
  });

  it("suggests --create or init for an unknown direct environment", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const client = fakeClient();

      let error: unknown;
      try {
        await useEnvironment("stage", { path: projectDir }, { client });
      } catch (err: unknown) {
        error = err;
      }

      expect(error).toBeInstanceOf(EnvdError);
      const envdError = error as EnvdError;
      expect(envdError.code).toBe("not_found");
      expect(envdError.message).toContain("envd use stage --create");
    });
  });

  it("creates an unknown environment when --create is provided", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const client = fakeClient();

      const result = await useEnvironment(
        "stage",
        { path: projectDir, create: true, providerEnvironment: "stg" },
        { client },
      );

      expect(result.activeEnvironment).toBe("stage");
      expect(client.createEnvironmentCalls).toEqual([
        { id: "project-1", name: "stage", providerEnvironment: "stg" },
      ]);
      expect(readEnvdConfig().projects[0]?.environments).toContainEqual({
        name: "stage",
        providerEnvironment: "stg",
      });
    });
  });

  it("summarizes staged changes for the old and new environments without clearing them", async () => {
    await withTempProject(async (projectDir) => {
      registerTestProject(projectDir);
      const client = fakeClient({
        diffs: new Map([
          ["default", { keys: { added: ["A"], modified: ["B"], deleted: [] } }],
          ["dev", { keys: { added: [], modified: [], deleted: ["C"] } }],
        ]),
      });

      const result = await useEnvironment(
        "dev",
        { path: projectDir },
        { client },
      );

      expect(result.staged).toEqual({
        previous: { added: 1, modified: 1, deleted: 0, total: 2 },
        active: { added: 0, modified: 0, deleted: 1, total: 1 },
      });
      expect(client.diffCalls).toEqual([
        { id: "project-1", opts: { environment: "default" } },
        { id: "project-1", opts: { environment: "dev" } },
      ]);
    });
  });
});
