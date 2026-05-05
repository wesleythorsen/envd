import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/shared/logger.js";
import type { ProviderContext } from "../../src/providers/base.js";
import { DEnvError } from "../../src/shared/errors.js";

interface MockBitwardenSecret {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly projectId: string | null;
}

interface MockBitwardenSyncResponse {
  readonly hasChanges: boolean;
  readonly secrets: readonly MockBitwardenSecret[];
}

interface MockBitwardenCreateCall {
  readonly organizationId: string;
  readonly key: string;
  readonly value: string;
  readonly note: string;
  readonly projectIds: readonly string[];
}

interface MockBitwardenUpdateCall extends MockBitwardenCreateCall {
  readonly id: string;
}

const bitwardenState = vi.hoisted(() => {
  return {
    settings: [] as Array<Record<string, unknown> | null>,
    logins: [] as string[],
    projectGets: [] as string[],
    syncOrgIds: [] as string[],
    createCalls: [] as MockBitwardenCreateCall[],
    updateCalls: [] as MockBitwardenUpdateCall[],
    deleteCalls: [] as string[][],
    project: { id: "project-1", organizationId: "org-1" },
    syncQueue: [] as Array<MockBitwardenSyncResponse | Error>,
    loginError: undefined as Error | undefined,
    projectError: undefined as Error | undefined,
    createError: undefined as Error | undefined,
    updateError: undefined as Error | undefined,
    deleteError: undefined as Error | undefined,
  };
});

vi.mock("@bitwarden/sdk-napi", () => {
  class BitwardenClient {
    constructor(settings?: unknown) {
      bitwardenState.settings.push(settings ?? null);
    }

    auth() {
      return {
        loginAccessToken: (token: string) => {
          bitwardenState.logins.push(token);
          if (bitwardenState.loginError !== undefined) {
            return Promise.reject(bitwardenState.loginError);
          }
          return Promise.resolve();
        },
      };
    }

    projects() {
      return {
        get: (id: string) => {
          bitwardenState.projectGets.push(id);
          if (bitwardenState.projectError !== undefined) {
            return Promise.reject(bitwardenState.projectError);
          }
          return Promise.resolve(bitwardenState.project);
        },
      };
    }

    secrets() {
      return {
        sync: (organizationId: string) => {
          bitwardenState.syncOrgIds.push(organizationId);
          if (bitwardenState.syncQueue.length === 0) {
            return Promise.resolve({ hasChanges: false, secrets: [] });
          }
          const next = bitwardenState.syncQueue.shift();
          if (next instanceof Error) {
            return Promise.reject(next);
          }
          return Promise.resolve(next ?? { hasChanges: false, secrets: [] });
        },
        create: (
          organizationId: string,
          key: string,
          value: string,
          note: string,
          projectIds: string[],
        ) => {
          bitwardenState.createCalls.push({
            organizationId,
            key,
            value,
            note,
            projectIds,
          });
          if (bitwardenState.createError !== undefined) {
            return Promise.reject(bitwardenState.createError);
          }
          return Promise.resolve({
            id: `${key}-id`,
            key,
            value,
            note,
            organizationId,
            projectId: projectIds[0] ?? null,
            creationDate: new Date(),
            revisionDate: new Date(),
          });
        },
        update: (
          organizationId: string,
          id: string,
          key: string,
          value: string,
          note: string,
          projectIds: string[],
        ) => {
          bitwardenState.updateCalls.push({
            organizationId,
            id,
            key,
            value,
            note,
            projectIds,
          });
          if (bitwardenState.updateError !== undefined) {
            return Promise.reject(bitwardenState.updateError);
          }
          return Promise.resolve({
            id,
            key,
            value,
            note,
            organizationId,
            projectId: projectIds[0] ?? null,
            creationDate: new Date(),
            revisionDate: new Date(),
          });
        },
        delete: (ids: string[]) => {
          bitwardenState.deleteCalls.push(ids);
          if (bitwardenState.deleteError !== undefined) {
            return Promise.reject(bitwardenState.deleteError);
          }
          return Promise.resolve({ data: ids.map((id) => ({ id })) });
        },
      };
    }
  }

  return {
    BitwardenClient,
  };
});

async function loadProvider() {
  vi.resetModules();
  return (await import("../../src/providers/bitwarden-secret-manager/index.js"))
    .default;
}

function makeContext(token = "bw.test-token"): ProviderContext {
  return {
    keychain: {
      set() {
        return Promise.resolve();
      },
      get(_service, account) {
        return Promise.resolve(account === "accessToken" ? token : null);
      },
      delete() {
        return Promise.resolve();
      },
    },
    logger: createLogger("bitwarden-test"),
    fetch: globalThis.fetch,
  };
}

async function createInstance(token?: string) {
  const provider = await loadProvider();
  return provider.create(makeContext(token), {
    projectId: "project-1",
    apiUrl: "https://api.bitwarden.test",
  });
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
  bitwardenState.settings = [];
  bitwardenState.logins = [];
  bitwardenState.projectGets = [];
  bitwardenState.syncOrgIds = [];
  bitwardenState.createCalls = [];
  bitwardenState.updateCalls = [];
  bitwardenState.deleteCalls = [];
  bitwardenState.project = { id: "project-1", organizationId: "org-1" };
  bitwardenState.syncQueue = [];
  bitwardenState.loginError = undefined;
  bitwardenState.projectError = undefined;
  bitwardenState.createError = undefined;
  bitwardenState.updateError = undefined;
  bitwardenState.deleteError = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bitwarden secret manager provider", () => {
  it("fetches only the secrets assigned to the configured project", async () => {
    bitwardenState.syncQueue.push({
      hasChanges: true,
      secrets: [
        {
          id: "secret-1",
          key: "FOO",
          value: "bar",
          projectId: "project-1",
        },
        {
          id: "secret-2",
          key: "OTHER",
          value: "skip",
          projectId: "project-2",
        },
      ],
    });

    const provider = await createInstance();

    expect(await provider.fetch()).toEqual({ FOO: "bar" });
    expect(bitwardenState.projectGets).toEqual(["project-1"]);
    expect(bitwardenState.syncOrgIds).toEqual(["org-1"]);
  });

  it("tests project access with a cheap authenticated project read", async () => {
    const provider = await createInstance();

    expect(await provider.test()).toEqual({ ok: true });
    expect(bitwardenState.syncOrgIds).toEqual([]);
    expect(bitwardenState.projectGets).toEqual(["project-1"]);
  });

  it("creates, updates, and deletes secrets in the configured project", async () => {
    bitwardenState.syncQueue.push({
      hasChanges: true,
      secrets: [
        {
          id: "secret-1",
          key: "EXISTING",
          value: "old",
          projectId: "project-1",
        },
        {
          id: "secret-2",
          key: "REMOVE_ME",
          value: "gone",
          projectId: "project-1",
        },
      ],
    });

    const provider = await createInstance();

    expect(
      await provider.push({
        upserts: { EXISTING: "new", CREATED: "fresh" },
        deletes: ["REMOVE_ME"],
      }),
    ).toEqual({
      status: "ok",
      applied: {
        upserts: { EXISTING: "new", CREATED: "fresh" },
        deletes: ["REMOVE_ME"],
      },
    });
    expect(bitwardenState.updateCalls).toEqual([
      {
        organizationId: "org-1",
        id: "secret-1",
        key: "EXISTING",
        value: "new",
        note: "",
        projectIds: ["project-1"],
      },
    ]);
    expect(bitwardenState.createCalls).toEqual([
      {
        organizationId: "org-1",
        key: "CREATED",
        value: "fresh",
        note: "",
        projectIds: ["project-1"],
      },
    ]);
    expect(bitwardenState.deleteCalls).toEqual([["secret-2"]]);
  });

  it("returns conflict with a fresh remote snapshot when a later write fails", async () => {
    bitwardenState.syncQueue.push(
      {
        hasChanges: true,
        secrets: [
          {
            id: "secret-1",
            key: "KEEP",
            value: "before",
            projectId: "project-1",
          },
          {
            id: "secret-2",
            key: "REMOVE_ME",
            value: "before",
            projectId: "project-1",
          },
        ],
      },
      {
        hasChanges: true,
        secrets: [
          {
            id: "secret-1",
            key: "KEEP",
            value: "after",
            projectId: "project-1",
          },
          {
            id: "secret-2",
            key: "REMOVE_ME",
            value: "still-here",
            projectId: "project-1",
          },
        ],
      },
    );
    bitwardenState.deleteError = new Error("503 service unavailable");

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

  it("maps authorization failures to provider_auth", async () => {
    bitwardenState.projectError = new Error("403 forbidden");

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_auth");
  });

  it("maps rate limiting and network failures to provider_unreachable", async () => {
    bitwardenState.syncQueue.push(new Error("429 rate limit exceeded"));

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_unreachable");
  });

  it("returns a failed test result when the access token is missing", async () => {
    const provider = await createInstance("");

    expect(await provider.test()).toEqual({
      ok: false,
      reason: "bitwarden-secret-manager provider requires accessToken",
    });
  });

  it("rejects malformed secret payloads as provider_unreachable", async () => {
    bitwardenState.syncQueue.push({
      hasChanges: true,
      secrets: [
        { id: "secret-1", key: "BROKEN", value: 42, projectId: "project-1" },
      ],
    });

    const provider = await createInstance();
    const err = await expectDEnvError(provider.fetch());

    expect(err.code).toBe("provider_unreachable");
    expect(err.cause).toBeInstanceOf(TypeError);
  });
});
