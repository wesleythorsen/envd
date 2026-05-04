import { describe, expect, it } from "vitest";
import {
  diffSecrets,
  diffToChangeSet,
  mergeSecrets,
  secretsKind,
} from "../../src/kinds/secrets/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

  it("parses and renders dotenv through the secrets data kind", () => {
    const parsed = secretsKind.parse(encoder.encode("B=2\nA=one two\n"), {
      format: "dotenv",
    });

    expect(parsed).toEqual({ B: "2", A: "one two" });
    expect(
      decoder.decode(
        secretsKind.render(parsed, {
          format: "dotenv",
          options: { quote: "always", sortKeys: "alphabetical" },
        }),
      ),
    ).toBe('A="one two"\nB="2"\n');
  });
});
