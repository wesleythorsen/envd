import { describe, expect, it } from "vitest";
import {
  addProviderInstance,
  buildProviderCommand,
  listProviders,
  removeProviderInstance,
  testProviderInstance,
} from "../../src/cli/commands/provider.js";
import type {
  ControlClient,
  CreateProviderInstanceInput,
  ProviderInstanceDetail,
  ProviderMetadata,
} from "../../src/ipc/control-client.js";
import { EnvdError } from "../../src/shared/errors.js";

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

function fakeClient(overrides: Partial<ControlClient> = {}): ControlClient {
  return {
    health: () => Promise.resolve({ ok: true, version: "test", uptimeSec: 0 }),
    version: () =>
      Promise.resolve({ cli: null, daemon: "test", protocol: "v1" }),
    createProject: () => Promise.reject(new Error("not needed")),
    getProject: () => Promise.reject(new Error("not needed")),
    getProjectDiff: () => Promise.reject(new Error("not needed")),
    commitProject: () => Promise.reject(new Error("not needed")),
    pullProject: () => Promise.reject(new Error("not needed")),
    deleteProject: () => Promise.resolve(),
    listProviders: () => Promise.resolve([localFileMetadata]),
    createProviderInstance: () => Promise.resolve({ id: "instance-1" }),
    listProviderInstances: () => Promise.resolve([]),
    getProviderInstance: () => Promise.reject(new Error("not needed")),
    deleteProviderInstance: () => Promise.resolve(),
    testProviderInstance: () => Promise.resolve({ ok: true }),
    shutdown: () => Promise.resolve(),
    ...overrides,
  };
}

describe("provider command helpers", () => {
  it("lists registered providers and configured instances", async () => {
    const instance: ProviderInstanceDetail = {
      id: "instance-1",
      provider: "local-file",
      name: "Local secrets",
      config: { path: "/tmp/secrets.json" },
      createdAt: 1,
    };
    const result = await listProviders({
      client: fakeClient({
        listProviderInstances: () => Promise.resolve([instance]),
      }),
    });

    expect(result.providers).toEqual([localFileMetadata]);
    expect(result.providerInstances).toEqual([instance]);
  });

  it("adds a provider instance from non-interactive JSON flags", async () => {
    const metadata: ProviderMetadata = {
      ...localFileMetadata,
      name: "credentialed",
      credentialKeys: ["apiToken"],
    };
    let createdInput: CreateProviderInstanceInput | undefined;
    const result = await addProviderInstance(
      "credentialed",
      {
        name: "CI local",
        configJson: '{"path":"/tmp/secrets.json"}',
        credentialsJson: '{"apiToken":"secret-value"}',
      },
      {
        client: fakeClient({
          listProviders: () => Promise.resolve([metadata]),
          createProviderInstance: (input) => {
            createdInput = input;
            return Promise.resolve({ id: "instance-1" });
          },
        }),
      },
    );

    expect(result).toEqual({
      status: "created",
      id: "instance-1",
      provider: "credentialed",
      name: "CI local",
    });
    expect(createdInput).toEqual({
      provider: "credentialed",
      name: "CI local",
      config: { path: "/tmp/secrets.json" },
      credentials: { apiToken: "secret-value" },
    });
  });

  it("parses --config-json and --credentials-json through the commander command", async () => {
    let createdInput: CreateProviderInstanceInput | undefined;
    let stdout = "";
    const command = buildProviderCommand({
      client: fakeClient({
        createProviderInstance: (input) => {
          createdInput = input;
          return Promise.resolve({ id: "instance-1" });
        },
      }),
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
    });

    await command.parseAsync(
      [
        "add",
        "local-file",
        "--name",
        "CI local",
        "--config-json",
        '{"path":"/tmp/secrets.json"}',
        "--credentials-json",
        "{}",
        "--json",
      ],
      { from: "user" },
    );

    expect(createdInput).toEqual({
      provider: "local-file",
      name: "CI local",
      config: { path: "/tmp/secrets.json" },
      credentials: {},
    });
    expect(JSON.parse(stdout) as unknown).toEqual({
      status: "created",
      id: "instance-1",
      provider: "local-file",
      name: "CI local",
    });
  });

  it("prompts config from string, boolean, and enum schema fields, then prompts credentials separately", async () => {
    const metadata: ProviderMetadata = {
      name: "test-provider",
      environmentMode: "config-adapter",
      instanceConfigSchema: {
        type: "object",
        properties: {
          path: { type: "string", title: "Path" },
          enabled: { type: "boolean", title: "Enabled" },
          mode: { title: "Mode", enum: ["dev", "prod"] },
        },
        required: ["path", "enabled", "mode"],
      },
      credentialKeys: ["apiToken"],
    };
    const answers = ["/tmp/secrets.json", "yes", "2"];
    const secretPrompts: string[] = [];
    let createdInput: CreateProviderInstanceInput | undefined;

    await addProviderInstance(
      "test-provider",
      { name: "Prompted" },
      {
        client: fakeClient({
          listProviders: () => Promise.resolve([metadata]),
          createProviderInstance: (input) => {
            createdInput = input;
            return Promise.resolve({ id: "instance-1" });
          },
        }),
        prompt: () => Promise.resolve(answers.shift() ?? ""),
        promptSecret: (question) => {
          secretPrompts.push(question);
          return Promise.resolve("secret-value");
        },
      },
    );

    expect(createdInput).toEqual({
      provider: "test-provider",
      name: "Prompted",
      config: {
        path: "/tmp/secrets.json",
        enabled: true,
        mode: "prod",
      },
      credentials: { apiToken: "secret-value" },
    });
    expect(secretPrompts).toEqual(["Credential apiToken"]);
  });

  it("removes a provider instance only after confirmation", async () => {
    const deletedIds: string[] = [];
    const result = await removeProviderInstance(
      "instance-1",
      {},
      {
        client: fakeClient({
          deleteProviderInstance: (id) => {
            deletedIds.push(id);
            return Promise.resolve();
          },
        }),
        confirm: () => Promise.resolve(true),
      },
    );

    expect(result).toEqual({ status: "removed", id: "instance-1" });
    expect(deletedIds).toEqual(["instance-1"]);
  });

  it("does not remove when confirmation is declined", async () => {
    await expect(
      removeProviderInstance(
        "instance-1",
        {},
        {
          client: fakeClient(),
          confirm: () => Promise.resolve(false),
        },
      ),
    ).rejects.toSatisfy((error: unknown) => {
      return error instanceof EnvdError && error.code === "usage_error";
    });
  });

  it("tests a provider instance", async () => {
    const result = await testProviderInstance("instance-1", {
      client: fakeClient({
        testProviderInstance: (id) => {
          expect(id).toBe("instance-1");
          return Promise.resolve({ ok: true });
        },
      }),
    });

    expect(result).toEqual({
      status: "tested",
      id: "instance-1",
      result: { ok: true },
    });
  });
});
