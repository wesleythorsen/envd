import type { ChangeSet, SecretMap } from "../../providers/base.js";

export interface SecretDiff {
  readonly added: Readonly<Record<string, string>>;
  readonly modified: Readonly<
    Record<string, { readonly before: string; readonly after: string }>
  >;
  readonly deleted: Readonly<Record<string, string>>;
}

export interface SecretDiffKeys {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

function sortedKeys(map: SecretMap): readonly string[] {
  return Object.keys(map).sort();
}

function sortedUnionKeys(a: SecretMap, b: SecretMap): readonly string[] {
  return [...new Set([...sortedKeys(a), ...sortedKeys(b)])].sort();
}

export function diffSecrets(before: SecretMap, after: SecretMap): SecretDiff {
  const added: Record<string, string> = {};
  const modified: Record<
    string,
    { readonly before: string; readonly after: string }
  > = {};
  const deleted: Record<string, string> = {};

  for (const key of sortedUnionKeys(before, after)) {
    const beforeValue = before[key];
    const afterValue = after[key];

    if (beforeValue === undefined) {
      if (afterValue !== undefined) {
        added[key] = afterValue;
      }
      continue;
    }

    if (afterValue === undefined) {
      deleted[key] = beforeValue;
      continue;
    }

    if (beforeValue !== afterValue) {
      modified[key] = { before: beforeValue, after: afterValue };
    }
  }

  return { added, modified, deleted };
}

export function toSecretDiffKeys(diff: SecretDiff): SecretDiffKeys {
  return {
    added: Object.keys(diff.added).sort(),
    modified: Object.keys(diff.modified).sort(),
    deleted: Object.keys(diff.deleted).sort(),
  };
}

export function diffSecretKeys(
  before: SecretMap,
  after: SecretMap,
): SecretDiffKeys {
  return toSecretDiffKeys(diffSecrets(before, after));
}

export function mergeSecrets(remote: SecretMap, staged: SecretDiff): SecretMap {
  const merged: Record<string, string> = { ...remote };

  for (const key of Object.keys(staged.deleted)) {
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

export function diffToChangeSet(diff: SecretDiff): ChangeSet {
  const upserts: Record<string, string> = {};

  for (const [key, value] of Object.entries(diff.added)) {
    upserts[key] = value;
  }

  for (const [key, change] of Object.entries(diff.modified)) {
    upserts[key] = change.after;
  }

  return { upserts, deletes: Object.keys(diff.deleted).sort() };
}
