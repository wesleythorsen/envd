import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/shared/logger.js";
import type { ProviderContext } from "../../src/providers/base.js";
import { DEnvError } from "../../src/shared/errors.js";

type MockAwsInput = Record<string, unknown>;
type MockAwsResponse = Record<string, unknown>;

interface MockAwsCommand {
  readonly __type: string;
  readonly input: MockAwsInput;
}

type MockAwsHandler =
  | MockAwsResponse
  | Error
  | ((command: MockAwsCommand) => MockAwsResponse);

const awsState = vi.hoisted(() => {
  return {
    clientConfigs: [] as unknown[],
    commands: [] as Array<{ type: string; input: MockAwsInput }>,
    handlers: [] as MockAwsHandler[],
    destroyCount: 0,
    fromIniCalls: [] as unknown[],
  };
});

vi.mock("@aws-sdk/credential-provider-ini", () => {
  return {
    fromIni: (opts: unknown) => {
      awsState.fromIniCalls.push(opts);
      return { source: "fromIni", opts };
    },
  };
});

vi.mock("@aws-sdk/client-secrets-manager", () => {
  class SecretsManagerClient {
    constructor(config: unknown) {
      awsState.clientConfigs.push(config);
    }

    send(command: MockAwsCommand) {
      awsState.commands.push({ type: command.__type, input: command.input });
      const next = awsState.handlers.shift();
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      if (typeof next === "function") {
        return Promise.resolve(next(command));
      }
      return Promise.resolve(next ?? {});
    }

    destroy() {
      awsState.destroyCount += 1;
    }
  }

  class ListSecretsCommand {
    readonly __type = "ListSecretsCommand";
    constructor(readonly input: MockAwsInput) {}
  }

  class GetSecretValueCommand {
    readonly __type = "GetSecretValueCommand";
    constructor(readonly input: MockAwsInput) {}
  }

  class CreateSecretCommand {
    readonly __type = "CreateSecretCommand";
    constructor(readonly input: MockAwsInput) {}
  }

  class PutSecretValueCommand {
    readonly __type = "PutSecretValueCommand";
    constructor(readonly input: MockAwsInput) {}
  }

  class DeleteSecretCommand {
    readonly __type = "DeleteSecretCommand";
    constructor(readonly input: MockAwsInput) {}
  }

  return {
    SecretsManagerClient,
    ListSecretsCommand,
    GetSecretValueCommand,
    CreateSecretCommand,
    PutSecretValueCommand,
    DeleteSecretCommand,
  };
});

async function loadProvider() {
  vi.resetModules();
  return (await import("../../src/providers/aws-secrets-manager/index.js"))
    .default;
}

function makeContext(): ProviderContext {
  return {
    keychain: {
      set() {
        return Promise.resolve();
      },
      get() {
        return Promise.resolve(null);
      },
      delete() {
        return Promise.resolve();
      },
    },
    logger: createLogger("aws-secrets-manager-test"),
    fetch: globalThis.fetch,
  };
}

async function createInstance(
  config: Record<string, unknown> = {
    region: "us-east-1",
    secretPrefix: "app/dev",
  },
) {
  const provider = await loadProvider();
  return provider.create(makeContext(), config);
}

function isDEnvErrorLike(err: unknown): err is DEnvError {
  return err instanceof Error && typeof Reflect.get(err, "code") === "string";
}

async function expectDEnvError(promise: Promise<unknown>): Promise<DEnvError> {
  try {
    await promise;
  } catch (err: unknown) {
    if (isDEnvErrorLike(err)) {
      expect(err.name).toBe("DEnvError");
      return err;
    }
    throw new Error("expected DEnvError", { cause: err });
  }
  throw new Error("expected promise to reject");
}

beforeEach(() => {
  awsState.clientConfigs = [];
  awsState.commands = [];
  awsState.handlers = [];
  awsState.destroyCount = 0;
  awsState.fromIniCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("aws secrets manager provider", () => {
  it("fetches string secrets beneath the configured prefix", async () => {
    awsState.handlers.push(
      () => ({
        SecretList: [
          { Name: "app/dev/FOO" },
          { Name: "app/dev/BAR" },
          { Name: "other/prefix/IGNORED" },
        ],
      }),
      () => ({ SecretString: "one" }),
      () => ({ SecretString: "two" }),
    );

    const provider = await createInstance();

    expect(await provider.fetch()).toEqual({ FOO: "one", BAR: "two" });
    expect(awsState.commands.map((command) => command.type)).toEqual([
      "ListSecretsCommand",
      "GetSecretValueCommand",
      "GetSecretValueCommand",
    ]);
  });

  it("honors profile and endpoint config during client creation and test()", async () => {
    awsState.handlers.push(() => ({ SecretList: [] }));

    const provider = await createInstance({
      region: "us-west-2",
      secretPrefix: "service/prod",
      profile: "dev-profile",
      endpoint: "http://localhost:4566",
    });

    expect(await provider.test()).toEqual({ ok: true });
    expect(awsState.fromIniCalls).toEqual([{ profile: "dev-profile" }]);
    expect(awsState.clientConfigs[0]).toMatchObject({
      region: "us-west-2",
      endpoint: "http://localhost:4566",
      credentials: { source: "fromIni", opts: { profile: "dev-profile" } },
    });
  });

  it("creates, updates, and deletes one secret per key", async () => {
    awsState.handlers.push(
      () => ({
        SecretList: [
          { Name: "app/dev/EXISTING" },
          { Name: "app/dev/REMOVE_ME" },
        ],
      }),
      () => ({ SecretString: "before" }),
      () => ({ SecretString: "old" }),
      () => ({ ARN: "arn:update" }),
      () => ({ ARN: "arn:create" }),
      (command) => {
        expect(command.input).toEqual({
          SecretId: "app/dev/REMOVE_ME",
          RecoveryWindowInDays: 7,
        });
        return { Name: "app/dev/REMOVE_ME" };
      },
    );

    const provider = await createInstance({
      region: "us-east-1",
      secretPrefix: "app/dev",
      deleteMode: "recoverable",
    });

    expect(
      await provider.push({
        upserts: { EXISTING: "after", CREATED: "fresh" },
        deletes: ["REMOVE_ME"],
      }),
    ).toEqual({
      status: "ok",
      applied: {
        upserts: { EXISTING: "after", CREATED: "fresh" },
        deletes: ["REMOVE_ME"],
      },
    });
    expect(awsState.commands.map((command) => command.type)).toEqual([
      "ListSecretsCommand",
      "GetSecretValueCommand",
      "GetSecretValueCommand",
      "PutSecretValueCommand",
      "CreateSecretCommand",
      "DeleteSecretCommand",
    ]);
  });

  it("returns conflict with a refreshed remote snapshot when a later write fails", async () => {
    const throttled = new Error("throttled");
    Object.assign(throttled, { name: "ThrottlingException" });

    awsState.handlers.push(
      () => ({
        SecretList: [{ Name: "app/dev/KEEP" }, { Name: "app/dev/REMOVE_ME" }],
      }),
      () => ({ SecretString: "before" }),
      () => ({ SecretString: "stale" }),
      () => ({ ARN: "arn:update" }),
      throttled,
      () => ({
        SecretList: [{ Name: "app/dev/KEEP" }, { Name: "app/dev/REMOVE_ME" }],
      }),
      () => ({ SecretString: "after" }),
      () => ({ SecretString: "still-here" }),
    );

    const provider = await createInstance();

    await expect(
      provider.push({
        upserts: { KEEP: "after" },
        deletes: ["REMOVE_ME"],
      }),
    ).resolves.toEqual({
      status: "conflict",
      remote: { KEEP: "after", REMOVE_ME: "still-here" },
    });
  });

  it("maps access failures to provider_auth", async () => {
    const accessDenied = new Error("Access denied");
    Object.assign(accessDenied, { name: "AccessDeniedException" });
    awsState.handlers.push(accessDenied);

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_auth");
  });

  it("maps throttling and service outages to provider_unreachable", async () => {
    const throttled = new Error("rate limited");
    Object.assign(throttled, { name: "ThrottlingException" });
    awsState.handlers.push(throttled);

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_unreachable");
  });

  it("rejects binary payloads as provider_unreachable", async () => {
    awsState.handlers.push(
      () => ({ SecretList: [{ Name: "app/dev/BINARY" }] }),
      () => ({ SecretBinary: new Uint8Array([1, 2, 3]) }),
    );

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_unreachable");
    expect(err.message).toContain("SecretBinary");
  });
});
