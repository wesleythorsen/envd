import { describe, expect, it } from "vitest";
import {
  diffSecrets,
  diffToChangeSet,
  mergeSecrets,
  secretsKind,
} from "../../src/kinds/secrets/index.js";
import { DEnvError } from "../../src/shared/errors.js";

describe("secretsKind", () => {
  it("names the secrets data kind", () => {
    expect(secretsKind.kind).toBe("secrets");
  });

  it("diffs added, modified, and deleted keys", () => {
    const diff = diffSecrets(
      { A: "old", B: "delete", C: "same" },
      { A: "new", C: "same", D: "add" },
    );

    expect(diff).toEqual({
      added: { D: "add" },
      modified: { A: { before: "old", after: "new" } },
      deleted: ["B"],
    });
  });

  it("merges a staged diff onto remote secrets", () => {
    const merged = mergeSecrets(
      { A: "old", B: "delete", C: "same" },
      {
        added: { D: "add" },
        modified: { A: { before: "old", after: "new" } },
        deleted: ["B"],
      },
    );

    expect(merged).toEqual({ A: "new", C: "same", D: "add" });
  });

  it("converts a diff to provider changes", () => {
    expect(
      diffToChangeSet({
        added: { D: "add" },
        modified: { A: { before: "old", after: "new" } },
        deleted: ["B"],
      }),
    ).toEqual({
      upserts: { A: "new", D: "add" },
      deletes: ["B"],
    });
  });

  it("leaves parse/render for the dotenv parser story", () => {
    expect(() => {
      secretsKind.parse(new Uint8Array(), { format: "dotenv" });
    }).toThrow(DEnvError);
    expect(() => {
      secretsKind.render({}, { format: "dotenv" });
    }).toThrow(DEnvError);
  });
});
