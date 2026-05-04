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
  CreateProviderInstanceInput,
  CreateProjectInput,
  CreateProjectResult,
  ProviderInstanceDetail,
  ProviderMetadata,
  ProjectDetail,
} from "../../src/ipc/control-client.js";
import { DEnvError } from "../../src/shared/errors.js";

const localFileMetadata: ProviderMetadata = {
  name: "local-file",
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
        new DEnvError("provider instance not found", { code: "not_found" }),
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
        { yes: true, providerInstance: "instance-1" },
        { client, ensureMount: false },
      );

      const projectFile = readFileSync(
        join(projectDir, ".d-env.json"),
        "utf-8",
      );
      expect(projectFile).not.toContain("token-1");
    });
  });

  it("prompts for an existing provider instance and posts the chosen id", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/d-env/p/project-1.token-1/.env",
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

  it("creates a provider instance through provider-add prompts when none exist", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/d-env/p/project-1.token-1/.env",
      );
      const answers = ["", "/tmp/secrets.json"];

      await initProject(
        projectDir,
        { yes: true },
        {
          client,
          ensureMount: false,
          prompt: () => Promise.resolve(answers.shift() ?? ""),
        },
      );

      expect(client.lastCreateProviderInstanceInput).toEqual({
        provider: "local-file",
        name: "local-file",
        config: { path: "/tmp/secrets.json" },
        credentials: {},
      });
      expect(client.lastCreateProjectInput).toEqual({
        path: projectDir,
        providerInstanceId: "instance-1",
      });
    });
  });

  it("creates a provider instance non-interactively from provider flags", async () => {
    await withTempProject(async (projectDir) => {
      const client = new FakeControlClient(
        "/Volumes/d-env/p/project-1.token-1/.env",
      );

      await initProject(
        projectDir,
        {
          yes: true,
          provider: "local-file",
          providerInstanceName: "CI local",
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
        "/Volumes/d-env/p/project-1.token-1/.env",
      );

      await initProject(
        projectDir,
        {
          yes: true,
          provider: "local-file",
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
