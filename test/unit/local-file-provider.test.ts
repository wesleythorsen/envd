import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import localFileProvider from "../../src/providers/local-file/index.js";
import { createLogger } from "../../src/shared/logger.js";
import type { ProviderContext } from "../../src/providers/base.js";
import { EnvdError } from "../../src/shared/errors.js";

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
    logger: createLogger("local-file-test"),
    fetch: globalThis.fetch,
  };
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "envd-local-file-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("local-file provider", () => {
  it("reads a missing file as an empty map", async () => {
    await withTempDir(async (dir) => {
      const provider = await localFileProvider.create(makeContext(), {
        path: join(dir, "secrets.json"),
      });

      expect(await provider.fetch()).toEqual({});
    });
  });

  it("pushes additions and deletions atomically", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "secrets.json");
      const provider = await localFileProvider.create(makeContext(), {
        path: filePath,
      });

      await provider.push({
        upserts: { A: "1", B: "2" },
        deletes: [],
      });
      expect(readFileSync(filePath, "utf-8")).toContain('"A": "1"');
      expect(await provider.fetch()).toEqual({ A: "1", B: "2" });

      await provider.push({
        upserts: { B: "updated", C: "3" },
        deletes: ["A"],
      });

      expect(await provider.fetch()).toEqual({ B: "updated", C: "3" });
      expect(() => {
        JSON.parse(readFileSync(filePath, "utf-8"));
      }).not.toThrow();
    });
  });

  it("reports readiness based on file readability or writable parent dir", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "secrets.json");
      const provider = await localFileProvider.create(makeContext(), {
        path: filePath,
      });

      expect(await provider.test()).toEqual({ ok: true });

      mkdirSync(join(dir, "locked"));
      const lockedProvider = await localFileProvider.create(makeContext(), {
        path: join(dir, "locked", "secrets.json"),
      });
      expect(await lockedProvider.test()).toEqual({ ok: true });
    });
  });

  it("rejects invalid JSON payloads", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "secrets.json");
      const provider = await localFileProvider.create(makeContext(), {
        path: filePath,
      });

      writeFileSync(filePath, JSON.stringify({ A: 1 }), "utf-8");
      await expect(provider.fetch()).rejects.toBeInstanceOf(EnvdError);
    });
  });

  it("validates config shape", async () => {
    await expect(
      localFileProvider.create(makeContext(), {}),
    ).rejects.toBeInstanceOf(EnvdError);
  });
});
