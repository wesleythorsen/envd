import { describe, expect, it } from "vitest";
import { findProvider, providers } from "../../src/providers/registry.js";

describe("provider registry", () => {
  it("starts with the built-in providers", () => {
    expect(providers.map((provider) => provider.name)).toEqual([
      "local-file",
      "doppler",
    ]);
  });

  it("finds the built-in local-file provider", () => {
    expect(findProvider("local-file")?.name).toBe("local-file");
  });

  it("finds the built-in doppler provider", () => {
    expect(findProvider("doppler")?.name).toBe("doppler");
  });

  it("returns undefined for unknown providers", () => {
    expect(findProvider("missing")).toBeUndefined();
  });
});
