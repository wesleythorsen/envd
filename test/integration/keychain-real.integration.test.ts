import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeychainAdapter } from "../../src/core/keychain.js";

const runRealKeychain =
  process.platform === "darwin" && process.env["D_ENV_TEST_KEYCHAIN"] === "1";

describe.skipIf(!runRealKeychain)("real macOS keychain adapter", () => {
  it("round-trips a credential through the OS keychain", async () => {
    const adapter = createKeychainAdapter();
    const service = `d-env-test-${randomUUID()}`;
    const account = "apiToken";

    try {
      await adapter.set(service, account, "secret-value");
      await expect(adapter.get(service, account)).resolves.toBe("secret-value");
    } finally {
      await adapter.delete(service, account);
    }
  }, 30_000);
});
