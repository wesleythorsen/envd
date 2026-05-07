import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import envdProvider from "../../src/providers/envd/index.js";
import { createLogger } from "../../src/shared/logger.js";
import type {
  KeychainAdapter,
  ProviderContext,
} from "../../src/providers/base.js";

function fakeKeychain(): KeychainAdapter & {
  readonly store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    set(service, account, secret) {
      store.set(`${service}\0${account}`, secret);
      return Promise.resolve();
    },
    get(service, account) {
      return Promise.resolve(store.get(`${service}\0${account}`) ?? null);
    },
    delete(service, account) {
      store.delete(`${service}\0${account}`);
      return Promise.resolve();
    },
  };
}

function makeContext(
  keychain: KeychainAdapter,
  projectId?: string,
  environment?: string,
): ProviderContext {
  return {
    keychain,
    logger: createLogger("envd-provider-test"),
    fetch: globalThis.fetch,
    ...(projectId === undefined ? {} : { projectId }),
    ...(environment === undefined ? {} : { environment }),
  };
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "envd-provider-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function readTree(dir: string): string {
  return readdirSync(dir)
    .map((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory()
        ? readTree(path)
        : readFileSync(path, "utf-8");
    })
    .join("\n");
}

describe("envd provider", () => {
  it("stores multiple environments for one project independently", async () => {
    await withTempDir(async (dir) => {
      const keychain = fakeKeychain();
      const config = { root: join(dir, "store") };
      const dev = await envdProvider.create(
        makeContext(keychain, "project-1", "dev"),
        config,
      );
      const stage = await envdProvider.create(
        makeContext(keychain, "project-1", "stage"),
        config,
      );

      await dev.push({ upserts: { SHARED: "dev" }, deletes: [] });
      await stage.push({ upserts: { SHARED: "stage" }, deletes: [] });

      expect(await dev.fetch()).toEqual({ SHARED: "dev" });
      expect(await stage.fetch()).toEqual({ SHARED: "stage" });
    });
  });

  it("stores projects independently and encrypts values at rest", async () => {
    await withTempDir(async (dir) => {
      const keychain = fakeKeychain();
      const config = { root: join(dir, "store") };
      const projectOne = await envdProvider.create(
        makeContext(keychain, "project-1", "dev"),
        config,
      );
      const projectTwo = await envdProvider.create(
        makeContext(keychain, "project-2", "dev"),
        config,
      );

      await projectOne.push({ upserts: { SECRET: "one" }, deletes: [] });
      await projectTwo.push({ upserts: { SECRET: "two" }, deletes: [] });

      expect(await projectOne.fetch()).toEqual({ SECRET: "one" });
      expect(await projectTwo.fetch()).toEqual({ SECRET: "two" });
      expect(readTree(join(dir, "store"))).not.toContain("one");
    });
  });

  it("tests without project scope and rejects fetch without scope", async () => {
    await withTempDir(async (dir) => {
      const keychain = fakeKeychain();
      const provider = await envdProvider.create(makeContext(keychain), {
        root: join(dir, "store"),
      });

      await expect(provider.test()).resolves.toEqual({ ok: true });
      await expect(provider.fetch()).rejects.toMatchObject({
        code: "usage_error",
      });
    });
  });
});
