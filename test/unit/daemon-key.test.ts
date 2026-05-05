import { describe, expect, it } from "vitest";
import { loadOrCreateDaemonKey } from "../../src/core/daemon-key.js";
import type { KeychainAdapter } from "../../src/core/keychain.js";

function fakeKeychain(
  initial: string | null = null,
): KeychainAdapter & { readonly store: Map<string, string> } {
  const store = new Map<string, string>();
  if (initial !== null) {
    store.set("d-env-daemon\0staging-encryption-key", initial);
  }

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

describe("loadOrCreateDaemonKey", () => {
  it("creates and stores a new 32-byte key when one does not exist", async () => {
    const keychain = fakeKeychain();
    const key = await loadOrCreateDaemonKey(keychain, {
      randomBytes: () => Buffer.alloc(32, 7),
    });

    expect(key).toEqual(Buffer.alloc(32, 7));
    expect(
      keychain.store.get("d-env-daemon\0staging-encryption-key"),
    ).toBe(Buffer.alloc(32, 7).toString("base64"));
  });

  it("loads an existing stored key", async () => {
    const encoded = Buffer.alloc(32, 3).toString("base64");
    const keychain = fakeKeychain(encoded);

    await expect(loadOrCreateDaemonKey(keychain)).resolves.toEqual(
      Buffer.alloc(32, 3),
    );
  });

  it("fails loudly when a key must exist but is missing", async () => {
    const keychain = fakeKeychain();

    await expect(
      loadOrCreateDaemonKey(keychain, { mustExist: true }),
    ).rejects.toMatchObject({
      code: "internal",
      message: "daemon encryption key is missing; cannot decrypt staged data",
    });
  });

  it("rejects invalid stored key material", async () => {
    const keychain = fakeKeychain("not-32-bytes");

    await expect(loadOrCreateDaemonKey(keychain)).rejects.toMatchObject({
      code: "internal",
      message: "daemon encryption key is invalid",
    });
  });
});
