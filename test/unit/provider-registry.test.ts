import { describe, expect, it } from "vitest";
import { findProvider, providers } from "../../src/providers/registry.js";

describe("provider registry", () => {
  it("starts with the built-in providers", () => {
    expect(providers.map((provider) => provider.name)).toEqual([
      "local-file",
      "doppler",
      "bitwarden-secret-manager",
      "aws-secrets-manager",
    ]);
  });

  it("finds the built-in local-file provider", () => {
    expect(findProvider("local-file")?.name).toBe("local-file");
  });

  it("finds the built-in doppler provider", () => {
    expect(findProvider("doppler")?.name).toBe("doppler");
  });

  it("finds the built-in bitwarden secret manager provider", () => {
    expect(findProvider("bitwarden-secret-manager")?.name).toBe(
      "bitwarden-secret-manager",
    );
  });

  it("finds the built-in aws secrets manager provider", () => {
    expect(findProvider("aws-secrets-manager")?.name).toBe(
      "aws-secrets-manager",
    );
  });

  it("returns undefined for unknown providers", () => {
    expect(findProvider("missing")).toBeUndefined();
  });
});
