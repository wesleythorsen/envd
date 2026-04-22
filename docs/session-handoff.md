# Session handoff — grounding for a new LLM session

**Read this first if you're picking up this project cold.** It summarizes everything you need to act without re-reading the brainstorm transcript. Skim it, then open the specific doc you need.

## The 60-second pitch

`d-env` replaces static `.env` files with a **virtual `.env`** backed by a local daemon. The real values live in a pluggable secrets backend (e.g. Doppler). The developer's app code is unchanged — it still does `dotenv.config()` and reads `./.env`. Behind the scenes, `.env` is a symlink into a WebDAV volume that our local daemon serves. Reads pull from the backend; writes are staged for review and pushed via a CLI `commit`.

## Why WebDAV specifically

- macOS and Linux both mount WebDAV natively (no FUSE, no kernel extensions).
- Loopback HTTP is our implementation medium — the daemon is just a local WebDAV server on `127.0.0.1`.
- When the OS reads the mounted file, it blocks on our HTTP response, which gives us the hook to generate content dynamically. `inotify`/`FSEvents` can't do this — they fire *after* access.

We ruled out plain symlinks (no event on read), FUSE (third-party install), NFS (heavyweight), and watcher-based pre-fetching (stale reads).

## Shape of the codebase

- **TypeScript**, Node ≥ 24, ESM.
- Single npm package, two binaries:
  - `d-env` — the CLI (short-lived).
  - `d-envd` — the daemon (long-running, per-user).
- The daemon owns all state. The CLI is a thin client that speaks to the daemon over a local control HTTP API.

See [architecture.md](architecture.md) for the component diagram and [daemon-spec.md](daemon-spec.md) for endpoints.

## Project layout (target)

```
src/
  cli/            CLI entrypoint + commands (thin client)
  daemon/
    main.ts       daemon entrypoint
    webdav/       WebDAV server (127.0.0.1)
    control/      Control HTTP API (127.0.0.1)
  core/
    project.ts    registry logic
    state.ts      SQLite store + migrations
    cache.ts      per-project snapshot cache with TTL
    rendering/
      dotenv.ts   parse + render
  providers/
    base.ts       interfaces
    registry.ts   explicit plugin list
    local-file/   built-in; JSON-backed (dev/test)
    doppler/      first real provider
  kinds/
    secrets/      v1 data kind
  mount/          OS-specific mount adapters (darwin, linux)
  ipc/            CLI ↔ daemon client
  shared/         logger, paths, error codes, types
test/
bin/              built entrypoints
docs/             everything; READ docs/README.md first
```

## What's done vs. what's next

- **Done**: brainstorm, project docs, tsconfig/eslint/prettier scaffolding, empty `src/`. See git log.
- **Next**: work through [work-breakdown.md](work-breakdown.md) user stories in wave order (Wave 0 → Wave 11). Each story is independently committable. [implementation-plan.md](implementation-plan.md) is the milestone-level view; `work-breakdown.md` is the unit-of-work view. When delegating to sub-agents, use the handoff prompt template at the bottom of `work-breakdown.md`.

## Stable contracts (don't break without a migration plan)

- `Provider`, `ProviderInstance`, `DataKind`, `MountAdapter` interfaces — see [extension-points.md](extension-points.md).
- Control API `/v1/*` shapes — see [daemon-spec.md](daemon-spec.md).
- CLI command names and flags — see [cli-spec.md](cli-spec.md).
- `.d-env.json` project file and `~/.d-env/state.db` schema.

## Design constraints to remember

- **No changes to consumer app code.** Reading `.env` must just work.
- **No kernel-level installs or third-party filesystem drivers.** WebDAV only.
- **Loopback-only HTTP.** Both WebDAV and control API bind `127.0.0.1`.
- **Never log secret values.** Log keys, counts, timings.
- **Secrets encrypted at rest.** OS keychain first; fallback file is encrypted.
- **Writes are staged, not pushed.** `commit` is always explicit.
- **Fail loud on provider errors.** `GET .env` returns an error; never a silent stale value.

## Extension slots (v1 design leaves room for these)

- **Additional providers**: AWS Secrets Manager, Vault, GCP SM, 1Password — plug in via the `Provider` interface.
- **Our own provider**: planned; self-hosted first, maybe SaaS later. Treated like any other plugin.
- **Other data kinds**: non-secret config (YAML/JSON), feature flags, templated files — plug in via the `DataKind` interface. Keep the daemon and CLI parameterized on kind.
- **Windows**: architecture permits it; v1 ships macOS + Linux only. Add a `MountAdapter` later.

## Useful mental models

- **"Git for secrets."** Reads = checked-out working copy; PUT = unstaged edit that auto-stages; `d-env diff/commit/pull` mirror git.
- **"Adapter, not replacement."** We don't want to be a secrets manager (yet). We're the file-shaped adapter between apps that read `.env` and managed secret backends.

## Pointers

- Product vision, scope, positioning: [vision.md](vision.md)
- **Declarative requirements tree** (source of truth for "is this done?"): [requirements.md](requirements.md)
- System components, protocols, data flow, security model: [architecture.md](architecture.md)
- CLI commands, flags, exit codes: [cli-spec.md](cli-spec.md)
- Daemon endpoints and WebDAV behavior: [daemon-spec.md](daemon-spec.md)
- How to add providers, data kinds, formats, mount adapters: [extension-points.md](extension-points.md)
- Phased plan, milestone by milestone: [implementation-plan.md](implementation-plan.md)
- Original brainstorm (for flavor, not required): [initial-idea-convo.md](initial-idea-convo.md)

## When in doubt

- Prefer boring code. This is developer infrastructure; surprises are bugs.
- Prefer additive work. If a change requires editing three extension-point files at once, reconsider the design.
- Prefer tests that exercise the real flow (WebDAV server + fake provider + real SQLite in a temp dir) over deep mocks.
- When the user says "Doppler" they mean it as an example. Always write the code against the `Provider` interface, not against Doppler specifically.
