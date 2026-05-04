import { describe, expect, it } from "vitest";
import { findProvider, providers } from "../../src/providers/registry.js";

describe("provider registry", () => {
  it("starts with no registered providers", () => {
    expect(providers).toEqual([]);
  });

  it("returns undefined for unknown providers", () => {
    expect(findProvider("local-file")).toBeUndefined();
  });
});
