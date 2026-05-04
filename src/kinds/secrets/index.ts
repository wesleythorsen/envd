import {
  parse as parseDotenv,
  render as renderDotenv,
} from "../../core/rendering/dotenv.js";
import type { SecretMap } from "../../providers/base.js";
import { diffSecrets, mergeSecrets } from "./diff.js";

export interface FormatConfig {
  readonly format: "dotenv";
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface Diff<TKey, TValue> {
  readonly added: Readonly<Record<string & TKey, TValue>>;
  readonly modified: Readonly<
    Record<string & TKey, { readonly before: TValue; readonly after: TValue }>
  >;
  readonly deleted: Readonly<Record<string & TKey, TValue>>;
}

export interface DataKind<TDoc, TKey, TValue> {
  readonly kind: string;
  parse(bytes: Uint8Array, format: FormatConfig): TDoc;
  render(doc: TDoc, format: FormatConfig): Uint8Array;
  diff(a: TDoc, b: TDoc): Diff<TKey, TValue>;
  merge(remote: TDoc, staged: Diff<TKey, TValue>): TDoc;
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

export {
  diffSecrets,
  diffSecretKeys,
  diffToChangeSet,
  mergeSecrets,
  toSecretDiffKeys,
} from "./diff.js";
export type { SecretDiff, SecretDiffKeys } from "./diff.js";
