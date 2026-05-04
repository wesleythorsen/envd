import type { Logger } from "../shared/logger.js";

export type JSONSchema =
  | boolean
  | {
      readonly type?: string | readonly string[];
      readonly title?: string;
      readonly description?: string;
      readonly properties?: Readonly<Record<string, JSONSchema>>;
      readonly required?: readonly string[];
      readonly additionalProperties?: JSONSchema;
      readonly enum?: readonly unknown[];
      readonly default?: unknown;
      readonly items?: JSONSchema;
    };

export interface Provider {
  readonly name: string;
  readonly instanceConfigSchema: JSONSchema;
  readonly credentialKeys: readonly string[];
  create(ctx: ProviderContext, config: unknown): Promise<ProviderInstance>;
}

export interface ProviderInstance {
  fetch(): Promise<SecretMap>;
  push(changes: ChangeSet): Promise<PushResult>;
  test(): Promise<{ ok: true } | { ok: false; reason: string }>;
  close?(): Promise<void>;
}

export type SecretMap = Readonly<Record<string, string>>;

export interface ChangeSet {
  readonly upserts: Record<string, string>;
  readonly deletes: readonly string[];
}

export type PushResult =
  | { readonly status: "ok"; readonly applied: ChangeSet }
  | { readonly status: "conflict"; readonly remote: SecretMap };

export interface KeychainAdapter {
  set(service: string, account: string, secret: string): Promise<void>;
  get(service: string, account: string): Promise<string | null>;
  delete(service: string, account: string): Promise<void>;
}

export interface ProviderContext {
  readonly keychain: KeychainAdapter;
  readonly logger: Logger;
  readonly fetch: typeof globalThis.fetch;
}
