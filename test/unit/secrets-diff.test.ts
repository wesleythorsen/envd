import { describe, expect, it } from "vitest";
import {
  diffSecretKeys,
  diffSecrets,
  diffToChangeSet,
  mergeSecrets,
  toSecretDiffKeys,
} from "../../src/kinds/secrets/diff.js";

describe("secret diff computation", () => {
  it("returns empty groups when both maps are empty", () => {
    expect(diffSecrets({}, {})).toEqual({
      added: {},
      modified: {},
      deleted: {},
    });
  });

  it("returns empty groups when maps are identical", () => {
    expect(diffSecrets({ A: "1", B: "2" }, { A: "1", B: "2" })).toEqual({
      added: {},
      modified: {},
      deleted: {},
    });
  });

  it("captures added keys with values", () => {
    expect(diffSecrets({ A: "1" }, { A: "1", B: "2" })).toEqual({
      added: { B: "2" },
      modified: {},
      deleted: {},
    });
  });

  it("captures modified keys with before and after values", () => {
    expect(diffSecrets({ A: "old" }, { A: "new" })).toEqual({
      added: {},
      modified: { A: { before: "old", after: "new" } },
      deleted: {},
    });
  });

  it("captures deleted keys with previous values", () => {
    expect(diffSecrets({ A: "1", B: "2" }, { A: "1" })).toEqual({
      added: {},
      modified: {},
      deleted: { B: "2" },
    });
  });

  it("returns deterministic structured diff groups", () => {
    const diff = diffSecrets(
      { Z: "delete", B: "old", A: "same" },
      { C: "add", A: "same", B: "new" },
    );

    expect(Object.keys(diff.added)).toEqual(["C"]);
    expect(Object.keys(diff.modified)).toEqual(["B"]);
    expect(Object.keys(diff.deleted)).toEqual(["Z"]);
    expect(diff).toEqual({
      added: { C: "add" },
      modified: { B: { before: "old", after: "new" } },
      deleted: { Z: "delete" },
    });
  });

  it("projects a value-bearing diff to keys only", () => {
    const diff = diffSecrets({ C: "remove", B: "old" }, { A: "add", B: "new" });

    expect(toSecretDiffKeys(diff)).toEqual({
      added: ["A"],
      modified: ["B"],
      deleted: ["C"],
    });
  });

  it("computes a keys-only diff directly from two maps", () => {
    expect(diffSecretKeys({ A: "1", C: "3" }, { B: "2", C: "4" })).toEqual({
      added: ["B"],
      modified: ["C"],
      deleted: ["A"],
    });
  });

  it("converts value-bearing diffs to provider changes", () => {
    expect(
      diffToChangeSet({
        added: { D: "add" },
        modified: { A: { before: "old", after: "new" } },
        deleted: { B: "delete" },
      }),
    ).toEqual({
      upserts: { A: "new", D: "add" },
      deletes: ["B"],
    });
  });

  it("merges a structured diff onto remote secrets", () => {
    expect(
      mergeSecrets(
        { A: "old", B: "delete", C: "same" },
        {
          added: { D: "add" },
          modified: { A: { before: "old", after: "new" } },
          deleted: { B: "delete" },
        },
      ),
    ).toEqual({ A: "new", C: "same", D: "add" });
  });
});
