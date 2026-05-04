import {
  parse as parseDotenv,
  render as renderDotenv,
} from "../../core/rendering/dotenv.js";
import type { ChangeSet, SecretMap } from "../../providers/base.js";

export interface FormatConfig {
  readonly format: "dotenv";
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface Diff<TKey, TValue> {
  readonly added: Readonly<Record<string & TKey, TValue>>;
  readonly modified: Readonly<
    Record<string & TKey, { readonly before: TValue; readonly after: TValue }>
  >;
  readonly deleted: readonly TKey[];
}

export interface DataKind<TDoc, TKey, TValue> {
  readonly kind: string;
  parse(bytes: Uint8Array, format: FormatConfig): TDoc;
  render(doc: TDoc, format: FormatConfig): Uint8Array;
  diff(a: TDoc, b: TDoc): Diff<TKey, TValue>;
  merge(remote: TDoc, staged: Diff<TKey, TValue>): TDoc;
}

export type SecretDiff = Diff<string, string>;

function diffSecrets(a: SecretMap, b: SecretMap): SecretDiff {
  const added: Record<string, string> = {};
  const modified: Record<string, { before: string; after: string }> = {};
  const deleted: string[] = [];

  for (const [key, before] of Object.entries(a)) {
    const after = b[key];
    if (after === undefined) {
      deleted.push(key);
    } else if (after !== before) {
      modified[key] = { before, after };
    }
  }

  for (const [key, value] of Object.entries(b)) {
    if (a[key] === undefined) {
      added[key] = value;
    }
  }

  return { added, modified, deleted };
}

function mergeSecrets(remote: SecretMap, staged: SecretDiff): SecretMap {
  const merged: Record<string, string> = { ...remote };

  for (const key of staged.deleted) {
    delete merged[key];
  }

  for (const [key, value] of Object.entries(staged.added)) {
    merged[key] = value;
  }

  for (const [key, change] of Object.entries(staged.modified)) {
    merged[key] = change.after;
  }

  return merged;
}

function diffToChangeSet(diff: SecretDiff): ChangeSet {
  const upserts: Record<string, string> = {};

  for (const [key, value] of Object.entries(diff.added)) {
    upserts[key] = value;
  }

  for (const [key, change] of Object.entries(diff.modified)) {
    upserts[key] = change.after;
  }

  return { upserts, deletes: diff.deleted };
}

export const secretsKind: DataKind<SecretMap, string, string> = {
  kind: "secrets",
  parse(bytes, format) {
    return parseDotenv(bytes, format.options);
  },
  render(doc, format) {
    return renderDotenv(doc, format.options);
  },
  diff: diffSecrets,
  merge: mergeSecrets,
};

export { diffSecrets, mergeSecrets, diffToChangeSet };
