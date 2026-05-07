import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject, type InitResult } from "../../src/cli/commands/init.js";
import type {
  ControlClient,
  CreateProviderInstanceInput,
  CreateProjectInput,
  CreateProjectResult,
  ProviderInstanceDetail,
  ProviderMetadata,
  ProjectDetail,
} from "../../src/ipc/control-client.js";
import { EnvdError } from "../../src/shared/errors.js";
import { readEnvdConfig } from "../../src/cli/config-file.js";

const localFileMetadata: ProviderMetadata = {
  name: "local-file",
  environmentMode: "config-adapter",
  instanceConfigSchema: {
    type: "object",
    properties: {
      path: { type: "string", title: "JSON file path" },
    },
    required: ["path"],
  },
  credentialKeys: [],
};

class FakeControlClient implements ControlClient {
  private project: ProjectDetail | undefined;
  private readonly providers: readonly ProviderMetadata[];
  private providerInstances: ProviderInstanceDetail[];
  createProjectCalls = 0;
  createProviderInstanceCalls = 0;
  createdEnvironments: Array<{ readonly id: string; readonly name: string }> =
    [];
  activeEnvironmentChanges: Array<{
    readonly id: string;
    readonly name: string;
  }> = [];
  importedEnvironments: Array<{
    readonly id: string;
    readonly environment: string;
    readonly values: Record<string, string>;
  }> = [];
  lastCreateProjectInput: CreateProjectInput | undefined;
  lastCreateProviderInstanceInput: CreateProviderInstanceInput | undefined;

  constructor(
    private readonly mountTarget: string,
    opts: {
      readonly providers?: readonly ProviderMetadata[];
      readonly providerInstances?: readonly ProviderInstanceDetail[];
    } = {},
  ) {
    this.providers = opts.providers ?? [localFileMetadata];
    this.providerInstances = [...(opts.providerInstances ?? [])];
  }

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
    this.lastCreateProjectInput = input;
    this.project = {
      id: "project-1",
      token: "token-1",
      path: input.path,
      providerInstanceId: input.providerInstanceId ?? null,
      activeEnvironment: "default",
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

  getProjectStatus(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  listProjectEnvironments(): Promise<never> {
    return Promise.reject(new Error("not needed"));
  }

  createProjectEnvironment(
    id: string,
    input: { readonly name: string },
  ): Promise<never> {
    this.createdEnvironments.push({ id, name: input.name });
    return Promise.resolve(undefined as never);
  }

  setProjectActiveEnvironment(
    id: string,
    name: string,
  ): Promise<ProjectDetail> {
    this.activeEnvironmentChanges.push({ id, name });
    if (this.project === undefined || this.project.id !== id) {
      return Promise.reject(new Error("project not found"));
    }
    this.project = { ...this.project, activeEnvironment: name };
    return Promise.resolve(this.project);
  }

  importProjectEnvironment(
    id: string,
    input: {
      readonly environment: string;
      readonly values: Record<string, string>;
    },
  ): Promise<{ environment: string; keyCount: number; verified: true }> {
    this.importedEnvironments.push({
      id,
      environment: input.environment,
      values: input.values,
    });
    return Promise.resolve({
      environment: input.environment,
      keyCount: Object.keys(input.values).length,
      verified: true,
    });
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

  listProviders(): Promise<readonly ProviderMetadata[]> {
    return Promise.resolve(this.providers);
  }

  createProviderInstance(
    input: CreateProviderInstanceInput,
  ): Promise<{ id: string }> {
    this.createProviderInstanceCalls += 1;
    this.lastCreateProviderInstanceInput = input;
    const instance: ProviderInstanceDetail = {
      id: `instance-${this.providerInstances.length + 1}`,
      provider: input.provider,
      name: input.name,
      config: input.config ?? {},
      createdAt: this.providerInstances.length + 1,
    };
    this.providerInstances = [...this.providerInstances, instance];
    return Promise.resolve({ id: instance.id });
  }

  listProviderInstances(): Promise<readonly ProviderInstanceDetail[]> {
    return Promise.resolve(this.providerInstances);
  }

  getProviderInstance(id: string): Promise<ProviderInstanceDetail> {
    const instance = this.providerInstances.find(
      (candidate) => candidate.id === id,
    );
    if (instance === undefined) {
      return Promise.reject(
        new EnvdError("provider instance not found", { code: "not_found" }),
      );
    }
    return Promise.resolve(instance);
  }

  deleteProviderInstance(): Promise<void> {
    return Promise.resolve();
  }

  testProviderInstance(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function withTempProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "envd-init-test-"));
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

describe("initProject", () => {
  it("registers a project, writes TOML metadata, creates symlink, and updates gitignore", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );

      const result: InitResult = await initProject(
        projectDir,
        { yes: true, providerInstance: "instance-1" },
        { client, ensureMount: false },
      );

      expect(result.status).toBe("initialized");
      expect(result.projectId).toBe("project-1");
      expect(client.createProjectCalls).toBe(1);
      expect(client.lastCreateProjectInput).toEqual({
        path: projectDir,
        providerInstanceId: "instance-1",
      });
      expect(existsSync(join(projectDir, ".envd.json"))).toBe(false);
      expect(readEnvdConfig().projects).toEqual([
        {
          id: "project-1",
          root: projectDir,
          providerInstanceId: "instance-1",
          activeEnvironment: "default",
          environments: [{ name: "default", providerEnvironment: "default" }],
        },
      ]);
      expect(readlinkSync(join(projectDir, ".env"))).toBe(
        "/Volumes/envd/p/project-1.token-1/.env",
      );
      expect(readFileSync(join(projectDir, ".gitignore"), "utf-8")).toBe(
        ".env\n",
      );
    });
  });

  it("is idempotent and recreates a missing symlink", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );
      await initProject(
        projectDir,
        { yes: true, providerInstance: "instance-1" },
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
        "/Volumes/envd/p/project-1.token-1/.env",
      );
    });
  });

  it("does not store the project token in the TOML registry", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );

      await initProject(
        projectDir,
        { yes: true, providerInstance: "instance-1" },
        { client, ensureMount: false },
      );

      expect(existsSync(join(projectDir, ".envd.json"))).toBe(false);
      expect(
        readFileSync(join(projectDir, "..", "config.toml"), "utf-8"),
      ).not.toContain("token-1");
    });
  });

  it("returns discovered env files from default and explicit scan paths", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );
      mkdirSync(join(projectDir, "env"));
      mkdirSync(join(projectDir, "packages", "api"), { recursive: true });
      writeFileSync(join(projectDir, ".env.dev"), "DEV=1\n", "utf-8");
      writeFileSync(join(projectDir, "env", "stage.env"), "STAGE=1\n", "utf-8");
      writeFileSync(
        join(projectDir, "packages", "api", ".env.prod"),
        "PROD=1\n",
        "utf-8",
      );

      const result = await initProject(
        projectDir,
        {
          yes: true,
          providerInstance: "instance-1",
          scan: ["packages/api"],
        },
        { client, ensureMount: false },
      );

      expect(result.envFiles.files.map((file) => file.relativePath)).toEqual([
        ".env.dev",
        "env/stage.env",
        "packages/api/.env.prod",
      ]);
      expect(
        result.envFiles.files.map((file) => file.classification.environment),
      ).toEqual(["dev", "stage", "prod"]);
      expect(client.createdEnvironments).toEqual([
        { id: "project-1", name: "dev" },
        { id: "project-1", name: "prod" },
        { id: "project-1", name: "stage" },
      ]);
      expect(client.activeEnvironmentChanges).toEqual([
        { id: "project-1", name: "dev" },
      ]);
      expect(readEnvdConfig().projects[0]?.activeEnvironment).toBe("dev");
    });
  });

  it("cancels after showing the adoption plan without mutating project state", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );
      writeFileSync(join(projectDir, ".env.dev"), "DEV=1\n", "utf-8");

      await expect(
        initProject(
          projectDir,
          { providerInstance: "instance-1" },
          {
            client,
            ensureMount: false,
            prompt: () => Promise.resolve(""),
            confirm: () => Promise.resolve(false),
          },
        ),
      ).rejects.toSatisfy((error: unknown) => {
        return error instanceof EnvdError && error.code === "usage_error";
      });

      expect(client.createProjectCalls).toBe(0);
      expect(client.createProviderInstanceCalls).toBe(0);
      expect(readEnvdConfig().projects).toEqual([]);
      expect(existsSync(join(projectDir, ".env"))).toBe(false);
    });
  });

  it("allows interactive environment remapping and active environment selection", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );
      writeFileSync(join(projectDir, ".env.dev"), "DEV=1\n", "utf-8");
      writeFileSync(join(projectDir, ".env.stage"), "STAGE=1\n", "utf-8");
      const answers = ["renamed", "prod", "prod"];

      const result = await initProject(
        projectDir,
        { providerInstance: "instance-1" },
        {
          client,
          ensureMount: false,
          prompt: () => Promise.resolve(answers.shift() ?? ""),
          confirm: () => Promise.resolve(true),
        },
      );

      expect(result.adoptionPlan.files.map((file) => file.environment)).toEqual(
        ["renamed", "prod"],
      );
      expect(result.adoptionPlan.activeEnvironment).toBe("prod");
      expect(client.createdEnvironments).toEqual([
        { id: "project-1", name: "prod" },
        { id: "project-1", name: "renamed" },
      ]);
      expect(client.activeEnvironmentChanges).toEqual([
        { id: "project-1", name: "prod" },
      ]);
      expect(readEnvdConfig().projects[0]).toMatchObject({
        activeEnvironment: "prod",
        environments: [
          { name: "default", providerEnvironment: "default" },
          { name: "prod", providerEnvironment: "prod" },
          { name: "renamed", providerEnvironment: "renamed" },
        ],
      });
    });
  });

  it("imports discovered env files, retires originals, and writes a receipt", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );
      const envPath = join(projectDir, ".env.dev");
      writeFileSync(envPath, "DEV=1\nSHARED=value\n", "utf-8");

      await initProject(
        projectDir,
        { yes: true, providerInstance: "instance-1" },
        { client, ensureMount: false },
      );

      expect(client.importedEnvironments).toEqual([
        {
          id: "project-1",
          environment: "dev",
          values: { DEV: "1", SHARED: "value" },
        },
      ]);
      expect(existsSync(envPath)).toBe(false);
      const retiredRoots = readdirSync(join(projectDir, ".envd-retired"));
      expect(retiredRoots).toHaveLength(1);
      const receiptPath = join(
        projectDir,
        ".envd-retired",
        retiredRoots[0] ?? "",
        "receipt.json",
      );
      expect(readFileSync(receiptPath, "utf-8")).toContain(
        "envd eject --from-retired",
      );
      expect(readFileSync(join(projectDir, ".gitignore"), "utf-8")).toContain(
        ".envd-retired/",
      );
    });
  });

  it("deletes imported env files only after verified import when requested", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );
      const envPath = join(projectDir, ".env.dev");
      writeFileSync(envPath, "DEV=1\n", "utf-8");

      await initProject(
        projectDir,
        {
          yes: true,
          providerInstance: "instance-1",
          deleteImportedFiles: true,
        },
        { client, ensureMount: false },
      );

      expect(client.importedEnvironments).toHaveLength(1);
      expect(existsSync(envPath)).toBe(false);
      expect(existsSync(join(projectDir, ".envd-retired"))).toBe(false);
    });
  });

  it("prompts for an existing provider instance and posts the chosen id", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
        {
          providerInstances: [
            {
              id: "instance-existing",
              provider: "local-file",
              name: "Local secrets",
              config: { path: "/tmp/secrets.json" },
              createdAt: 1,
            },
          ],
        },
      );
      const prompts: string[] = [];

      await initProject(
        projectDir,
        { yes: true },
        {
          client,
          ensureMount: false,
          prompt: (question) => {
            prompts.push(question);
            return Promise.resolve("1");
          },
        },
      );

      expect(prompts).toEqual([
        "Choose provider instance:\n1) Local secrets (local-file, instance-existing)\n2) Create new\nSelection",
      ]);
      expect(client.createProviderInstanceCalls).toBe(0);
      expect(client.lastCreateProjectInput).toEqual({
        path: projectDir,
        providerInstanceId: "instance-existing",
      });
    });
  });

  it("selects an existing provider instance by provider name flag", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
        {
          providerInstances: [
            {
              id: "instance-work",
              provider: "local-file",
              name: "work",
              config: { path: "/tmp/secrets.json" },
              createdAt: 1,
            },
          ],
        },
      );

      await initProject(
        projectDir,
        { yes: true, provider: "work" },
        {
          client,
          ensureMount: false,
          prompt: () => Promise.reject(new Error("unexpected prompt")),
        },
      );

      expect(client.createProviderInstanceCalls).toBe(0);
      expect(client.lastCreateProjectInput).toEqual({
        path: projectDir,
        providerInstanceId: "instance-work",
      });
    });
  });

  it("uses explicit env-file mappings and active environment for scripted init", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );
      writeFileSync(join(projectDir, "secrets.dev"), "DEV=1\n", "utf-8");
      writeFileSync(join(projectDir, "secrets.stage"), "STAGE=1\n", "utf-8");

      const result = await initProject(
        projectDir,
        {
          yes: true,
          providerInstance: "instance-1",
          envFile: ["dev=secrets.dev", "stage=secrets.stage"],
          active: "stage",
        },
        { client, ensureMount: false },
      );

      expect(result.adoptionPlan.files.map((file) => file.environment)).toEqual(
        ["dev", "stage"],
      );
      expect(result.adoptionPlan.activeEnvironment).toBe("stage");
      expect(client.createdEnvironments).toEqual([
        { id: "project-1", name: "dev" },
        { id: "project-1", name: "stage" },
      ]);
      expect(client.activeEnvironmentChanges).toEqual([
        { id: "project-1", name: "stage" },
      ]);
    });
  });

  it("fails non-interactive init when inferred mappings are ambiguous", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );
      writeFileSync(join(projectDir, ".env.local"), "LOCAL=1\n", "utf-8");

      await expect(
        initProject(
          projectDir,
          { yes: true, providerInstance: "instance-1" },
          { client, ensureMount: false },
        ),
      ).rejects.toSatisfy((error: unknown) => {
        return error instanceof EnvdError && error.code === "usage_error";
      });

      expect(client.createProjectCalls).toBe(0);
    });
  });

  it("creates a default personal local provider instance when none exist", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );

      await initProject(
        projectDir,
        { yes: true },
        {
          client,
          ensureMount: false,
          prompt: () => Promise.reject(new Error("unexpected prompt")),
        },
      );

      expect(client.lastCreateProviderInstanceInput).toMatchObject({
        provider: "envd",
        name: "personal",
        credentials: {},
      });
      const config = client.lastCreateProviderInstanceInput?.config;
      expect(typeof config?.["root"]).toBe("string");
      expect(config?.["root"]).toMatch(/providers\/personal$/);
      expect(client.lastCreateProjectInput).toEqual({
        path: projectDir,
        providerInstanceId: "instance-1",
      });
    });
  });

  it("creates a provider instance non-interactively from provider flags", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );

      await initProject(
        projectDir,
        {
          yes: true,
          newProvider: true,
          providerType: "local-file",
          providerName: "CI local",
          configJson: '{"path":"/tmp/secrets.json"}',
          credentialsJson: "{}",
        },
        {
          client,
          ensureMount: false,
          prompt: () => Promise.reject(new Error("unexpected prompt")),
        },
      );

      expect(client.lastCreateProviderInstanceInput).toEqual({
        provider: "local-file",
        name: "CI local",
        config: { path: "/tmp/secrets.json" },
        credentials: {},
      });
      expect(client.lastCreateProjectInput).toEqual({
        path: projectDir,
        providerInstanceId: "instance-1",
      });
    });
  });

  it("defaults the provider instance name for provider-driven scripting", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/envd/p/project-1.token-1/.env",
      );

      await initProject(
        projectDir,
        {
          yes: true,
          newProvider: true,
          providerType: "local-file",
          configJson: '{"path":"/tmp/secrets.json"}',
          credentialsJson: "{}",
        },
        {
          client,
          ensureMount: false,
          prompt: () => Promise.reject(new Error("unexpected prompt")),
        },
      );

      expect(client.lastCreateProviderInstanceInput).toMatchObject({
        provider: "local-file",
        name: "local-file",
      });
    });
  });
});
