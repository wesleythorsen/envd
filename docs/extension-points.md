# Extension points

This doc is the contract new code must honor so that future additions don't require rewrites. If you're adding a provider, a data kind, or a new output format, read this first.

## 1. Providers

### The interface

All providers implement:

```ts
export interface Provider {
  readonly name: string;                          // "doppler", "aws-secrets-manager", "local-file", …

  // Declares the shape of config required to create an instance. Used by the CLI
  // to render prompts and by the control API to validate POST bodies.
  readonly instanceConfigSchema: JSONSchema;

  // Declares which secret fields must be collected separately and stored in the keychain.
  readonly credentialKeys: readonly string[];     // e.g. ["apiToken"]

  // Factory: make an instance. Credentials are fetched from the keychain adapter passed in.
  create(ctx: ProviderContext, config: unknown): Promise<ProviderInstance>;
}

export interface ProviderInstance {
  fetch(): Promise<SecretMap>;                    // returns the current remote state
  push(changes: ChangeSet): Promise<PushResult>;  // applies a diff remotely
  test(): Promise<{ ok: true } | { ok: false; reason: string }>;
  close?(): Promise<void>;                        // optional cleanup
}

export type SecretMap = Readonly<Record<string, string>>;
export type ChangeSet = {
  upserts: Record<string, string>;
  deletes: readonly string[];
};
export type PushResult =
  | { status: "ok"; applied: ChangeSet }
  | { status: "conflict"; remote: SecretMap };    // caller resolves

export interface ProviderContext {
  keychain: KeychainAdapter;                      // for reading credentials
  logger: Logger;                                 // scoped logger (never logs values)
  fetch: typeof globalThis.fetch;                 // swappable in tests
}
```

### Rules

- Providers must be **pure** w.r.t. their inputs (same `fetch()` → same value if remote unchanged). No hidden per-process caches; the daemon manages caching outside the provider.
- `fetch()` must error, not return empty, on auth failures. The distinction between "no secrets defined" and "can't reach provider" must be preserved.
- `push()` must be atomic *per call* where the backend supports it; where it doesn't (e.g. AWS Secrets Manager with one secret per key), the provider is responsible for best-effort ordering and returning a meaningful `PushResult` on partial failure.
- `test()` must be idempotent and cheap. It's called from `d-env provider test` and during config creation.
- Provider code must not depend on `fs` or a specific Node globals beyond `ProviderContext`. That keeps them trivially unit-testable.

### Registering a provider

- Add `src/providers/<name>/` with `index.ts` exporting a `Provider` object as default.
- Register in `src/providers/registry.ts` (an explicit list for now — we want type-safety more than dynamic loading).
- Add a small integration test that runs against a fake server (`msw`) and a unit test per parser.

### Adding our own provider later

Our hypothetical self-hosted provider will be just another provider implementation. No special status. The only nuance: it'll ship as part of this repo (or a sibling package), and we may want the daemon to optionally *host* a local instance of it too. That host is a separate concern and can be a sibling binary (`d-env-store` or similar).

## 2. Data kinds

v1 only supports "secrets rendered as .env." Later we want configs, feature flags, maybe templated files. The design makes a **data kind** the top-level abstraction, not `.env` specifically.

### The interface

```ts
export interface DataKind<TDoc, TKey, TValue> {
  readonly kind: string;                          // "secrets", "config", "feature-flags"

  // Parse bytes (incoming PUT from WebDAV) into the canonical document.
  parse(bytes: Uint8Array, format: FormatConfig): TDoc;

  // Serialize the canonical document for a WebDAV GET.
  render(doc: TDoc, format: FormatConfig): Uint8Array;

  // Diff two documents for UI and for provider push.
  diff(a: TDoc, b: TDoc): Diff<TKey, TValue>;

  // Merge staging onto a remote doc, returning the effective doc a read should return.
  merge(remote: TDoc, staged: Diff<TKey, TValue>): TDoc;
}
```

For secrets, `TDoc = Record<string, string>`, `TKey = string`, `TValue = string`. Other kinds fill these in differently (feature flags might have typed values; configs might have nested structure).

### v1 placeholder

In v1 we only implement the secrets kind (`src/kinds/secrets/`). Everything else — daemon routing, CLI plumbing — is written parameterized on `DataKind` so adding a kind is additive.

## 3. Formats

A "format" is how a `DataKind` is rendered to bytes for a given project. For secrets we start with:

- `dotenv` — the standard `KEY=VALUE` shape, with quoting rules we control.

Future formats for the same kind:

- `json` — secrets as a flat JSON object (for JS apps that read config.json).
- `yaml` — same, YAML.
- `shell` — `export KEY=VALUE` lines.
- `systemd-env` — systemd's stricter env format.

Format config lives in the project's `.d-env.json`:

```json
{
  "projectId": "…",
  "provider": "doppler:my-project",
  "kind": "secrets",
  "format": "dotenv",
  "formatOptions": {
    "quote": "double",
    "sortKeys": "alphabetical",
    "prefix": ""
  },
  "mapping": {
    "strategy": "passthrough"
  }
}
```

### Mapping strategies

- `passthrough` — provider keys used verbatim.
- `rename` — explicit `{ from → to }` pairs; unmapped keys dropped.
- `prefix-strip` — take only keys starting with a prefix, strip the prefix.

New strategies plug in under `src/mapping/`.

## 4. Mount adapters

The OS-mount step is isolated in `src/mount/`:

```ts
export interface MountAdapter {
  readonly platform: "darwin" | "linux" | "win32";
  isMounted(path: string): Promise<boolean>;
  mount(url: string, path: string): Promise<void>;
  unmount(path: string): Promise<void>;
}
```

We ship `darwin` and `linux` adapters in v1. Adding Windows is implementing a third adapter and wiring it into the factory. No other code should contain platform `switch`es on mount.

## 5. Stable surfaces

These surfaces are considered API and must not break without a major-version bump:

- `Provider`, `ProviderInstance`, `DataKind`, `MountAdapter` interfaces.
- Control API `/v1/*` shapes (paths, request/response bodies, error codes).
- CLI command names and flags (deprecation requires a one-minor-version warning period).
- On-disk files: `.d-env.json` in projects, `~/.d-env/state.db` schema (migrations required for changes).

Anything in `src/internal/` or without a doc entry is not stable.
