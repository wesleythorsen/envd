import { describe, expect, it } from "vitest";
import type {
  ChangeSet,
  Provider,
  PushResult,
  SecretMap,
} from "../../src/providers/base.js";
import { createLogger } from "../../src/shared/logger.js";

describe("provider base contracts", () => {
  it("supports a provider implementation through the stable interface", async () => {
    const remote: Record<string, string> = { FOO: "bar" };
    const provider: Provider = {
      name: "fake",
      environmentMode: "config-adapter",
      instanceConfigSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      credentialKeys: ["apiToken"],
      create(): Promise<{
        fetch(): Promise<SecretMap>;
        push(changes: ChangeSet): Promise<PushResult>;
        test(): Promise<{ ok: true }>;
      }> {
        return Promise.resolve({
          fetch() {
            return Promise.resolve(remote);
          },
          push(changes) {
            Object.assign(remote, changes.upserts);
            for (const key of changes.deletes) {
              delete remote[key];
            }
            return Promise.resolve({ status: "ok", applied: changes });
          },
          test() {
            return Promise.resolve({ ok: true });
          },
        });
      },
    };

    const instance = await provider.create({
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
      logger: createLogger("provider-test"),
      fetch: globalThis.fetch,
    });

    expect(await instance.fetch()).toEqual({ FOO: "bar" });
    const pushed = await instance.push({
      upserts: { BAZ: "qux" },
      deletes: ["FOO"],
    });
    expect(pushed.status).toBe("ok");
    expect(await instance.fetch()).toEqual({ BAZ: "qux" });
  });
});
