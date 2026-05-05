# Implementation plan

This plan moves the repo from empty to a working v0.1 (CLI + daemon + WebDAV + Doppler + `local-file`). It's ordered so each phase produces something the next phase can build on, and so early phases can be validated end-to-end before we invest in hardening.

## Milestones

- **M0 — Scaffolding in place.** Workspace layout, build, test, lint, CI-friendly scripts.
- **M1 — WebDAV walking skeleton.** Daemon serves a static `.env` over WebDAV; macOS mounts it; a sample project reads it successfully.
- **M2 — Control API + CLI skeleton.** CLI talks to daemon; `envd daemon start/stop/status` works.
- **M3 — Project registry + symlink.** `envd init` registers a project, creates the symlink; reads go through the registry.
- **M4 — Provider abstraction + `local-file`.** Reads pull from a provider instead of a constant.
- **M5 — Doppler provider.** Real-world read path works.
- **M6 — Write path (staging).** WebDAV `PUT` stages a diff; reads show the merged view.
- **M7 — `diff` / `commit` / `pull`.** Push staging back to the provider; conflict handling.
- **M8 — Hardening.** Keychain-backed credentials, encrypted state, token auth on WebDAV, logs, structured errors, Linux support.
- **M9 — Developer-experience polish.** `launchd` / `systemd` install, good error messages, `envd status` depth, docs pass.

The first three milestones together prove the core hypothesis. Everything after is "make it real."

---

## M0 — Scaffolding

**Goal**: builds cleanly, has an entry point for each binary, has tests that run.

Tasks:
- Add dependencies. Proposed (pin later):
  - Runtime: `webdav-server@^2`, `better-sqlite3`, `commander`, `undici` (for tests), optionally `fastify`.
  - Keychain: `keytar` (native; evaluate; fallback: `envc`-style age-based file).
  - Dev/test: `vitest`, `@types/better-sqlite3`.
- Expand `package.json`:
  - `bin`: `"envd": "dist/cli/main.js"`, `"envdd": "dist/daemon/main.js"`.
  - `scripts`: add `dev:cli`, `dev:daemon` (tsx watch), `test`, `test:watch`.
- Create directory skeleton:
  ```
  src/
    cli/main.ts
    daemon/main.ts
    daemon/webdav/
    daemon/control/
    core/
      project.ts
      state.ts
      cache.ts
      rendering/dotenv.ts
    providers/
      registry.ts
      base.ts
      local-file/index.ts
    mount/
      adapter.ts
      darwin.ts
      linux.ts
    ipc/
      control-client.ts
    kinds/
      secrets/index.ts
    shared/
      logger.ts
      paths.ts
      errors.ts
      types.ts
  test/
    unit/
    integration/
  ```
- Add `vitest.config.ts` pointing at `test/`.
- `npm run check` (typecheck + lint + format-check) stays green from this phase on. Do not land work that breaks it.

Deliverable: `npm run build && node dist/cli/main.js version` prints a stub version.

---

## M1 — WebDAV walking skeleton

**Goal**: validate the OS mount story end-to-end with a hardcoded file. If this doesn't work, *nothing else matters* — we find out early.

Tasks:
- `src/daemon/webdav/server.ts`: start a WebDAV server on `127.0.0.1:1911` that serves a single path `/hello/.env` with hardcoded content `HELLO=world`.
- `src/daemon/main.ts`: boot the WebDAV server, log the port.
- `src/mount/darwin.ts`: shell out to `mount_webdav`; implement `isMounted`, `mount`, `unmount`.
- A throwaway script `scripts/smoke-macos.ts`:
  1. Starts the daemon.
  2. Mounts at `/Volumes/envd-smoke`.
  3. `cat`s `/Volumes/envd-smoke/hello/.env`.
  4. Asserts content.
  5. Unmounts, stops daemon.
- Run this by hand on the dev machine.

Risk checks to actually do here, before writing more code:
- Does `mount_webdav` against a loopback plain-HTTP URL work without user interaction on current macOS? It should, but there are known quirks with HTTPS-only defaults in some macOS releases — confirm behavior now.
- What happens when the server returns a file with no `Last-Modified` header? (Some macOS versions retry aggressively.) Add one.

Deliverable: `npm run smoke:macos` passes locally.

---

## M2 — Control API + CLI skeleton

**Goal**: CLI can talk to the daemon; daemon lifecycle is managed from the CLI.

Tasks:
- `src/daemon/control/server.ts`: HTTP server on `127.0.0.1:1910`.
  - Endpoints: `/v1/health`, `/v1/version`, `/v1/shutdown`.
  - Bearer-token auth from `~/.envd/control.token` (generated on first boot).
- `src/ipc/control-client.ts`: tiny client wrapping `undici` (or `node:fetch`).
- `src/cli/main.ts` with `commander`:
  - `envd version` — prints CLI version and calls `/v1/version` for daemon version (if reachable).
  - `envd daemon start|stop|status` — spawns the daemon as a detached child, reads PID file, talks to `/v1/health`, calls `/v1/shutdown`.
- Port/PID management in `src/shared/paths.ts`.

Deliverable: `envd daemon start && envd daemon status && envd daemon stop` works from a clean state.

---

## M3 — Project registry + symlink

**Goal**: `envd init` produces a working `.env` symlink that resolves to a real WebDAV-served file.

Tasks:
- SQLite state store in `src/core/state.ts` (better-sqlite3). Implement migrations system (simple numbered files under `src/core/migrations/`).
- `projects` and `staging` tables per [daemon-spec.md](daemon-spec.md). Provider bits can be stubbed ("provider_instance_id" is nullable until M4).
- Control API:
  - `POST /v1/projects` (requires `path`; generates id+token; creates registry row; renders an empty `.env`).
  - `GET /v1/projects/:id`.
- WebDAV server:
  - Strip the hardcoded path; serve `/p/<id>.<tok>/.env` driven by the registry.
  - For M3, content is a placeholder string like `# envd project <id>` — no real provider yet.
  - `PUT` is a 405 for now.
- CLI:
  - `envd init`: registers, creates `<cwd>/.env` symlink to the mount path, writes `.envd.json` with `projectId` and non-secret metadata.
  - `envd status` (basic).
- Mount bootstrap: `init` checks for the mount and creates it if missing.
- Add `.env` to `.gitignore` if missing.

Deliverable: in a fresh scratch dir, `envd init` produces `./.env` whose contents say `# envd project …`. `cat .env` triggers a WebDAV read.

---

## M4 — Provider abstraction + `local-file`

**Goal**: reads pull from a real provider.

Tasks:
- Implement `Provider` / `ProviderInstance` / `ProviderContext` / `ChangeSet` / `SecretMap` interfaces in `src/providers/base.ts`.
- `src/providers/local-file/index.ts`: reads/writes a JSON file whose path is in its instance config. Supports `fetch()`, `push()`, `test()`. This doubles as a test fixture.
- `src/providers/registry.ts`: explicit export list.
- State store: `provider_instances` table.
- Control API:
  - `GET /v1/providers` (returns plugin metadata + schemas).
  - `POST /v1/provider-instances`, `GET …`, `DELETE …`, `POST …/test`.
  - `POST /v1/projects` now requires `providerInstanceId`.
- CLI:
  - `envd provider list|add|remove|test`.
  - `envd init` walks the user through provider-instance selection/creation.
- `src/kinds/secrets/` + `src/core/rendering/dotenv.ts`: parse + render. Unit-test quoting edge cases (newlines, quotes, unicode, keys with dots).
- WebDAV `GET` now:
  1. Loads project → provider instance.
  2. `instance.fetch()` (with cache wrap-around in `src/core/cache.ts`).
  3. Renders via `secrets + dotenv`.

Deliverable: configure a `local-file` provider pointing at `./test.json`, run `envd init`, edit `test.json`, re-read `.env`, see updated values.

---

## M5 — Doppler provider

**Goal**: it works against a real backend.

Tasks:
- `src/providers/doppler/index.ts`:
  - `fetch()` — call Doppler's `v3/configs/config/secrets/download` (or equivalent).
  - `push()` — use Doppler's batch update endpoint. Map `ChangeSet` to the required shape.
  - `test()` — cheap call like `v3/me` or a config GET.
  - Credentials via `ProviderContext.keychain`.
- Integration test with `msw` to mock Doppler's endpoints.
- Manual end-to-end: a real Doppler project (in a personal workspace, not prod) read through `envd`.

Deliverable: reading `.env` from a project wired to Doppler returns real values.

---

## M6 — Write path (staging)

**Goal**: editing `.env` produces a reviewable staged diff.

Tasks:
- WebDAV `PUT` handler:
  - Parse `.env` body.
  - Compute diff vs. `(cached remote ⊕ previous staging)`.
  - Overwrite staging in SQLite.
  - Return `204`.
- `staging` merge on `GET`.
- `LOCK`/`UNLOCK` minimal implementation for editor compat (advisory, in-memory lock table).
- Control API:
  - `GET /v1/projects/:id/diff` — structured diff.
- CLI:
  - `envd diff` (keys only by default; `--values` to reveal).

Deliverable: `echo "FOO=bar" >> .env && envd diff` shows `+FOO=bar` staged.

---

## M7 — `commit`, `pull`, conflicts

**Goal**: round-trip local edits to the provider.

Tasks:
- `POST /v1/projects/:id/commit` with body `{ message?, strategy: "abort"|"theirs"|"ours" }`:
  - Fresh `provider.fetch()`.
  - Detect conflicts (upstream changed a key the staging also touched).
  - Apply strategy; call `provider.push()`.
  - On success: clear staging, update snapshot, return applied `ChangeSet`.
- `POST /v1/projects/:id/pull` (drops staging, refreshes).
- CLI:
  - `envd commit [-m]`, `envd pull [--force] [--dry-run]`.
  - Interactive conflict resolver for v1 is stretch; `--theirs`/`--ours` is required.

Deliverable: edit `.env`, `envd diff`, `envd commit -m "rotate S3 key"`, see value in Doppler UI.

---

## M8 — Hardening

**Goal**: production-adjacent quality without adding features.

Tasks:
- **Keychain integration** for provider credentials and the per-daemon encryption key. Fallback: age-based encrypted file with passphrase cached via `ssh-agent`-like socket (stretch; start with an unencrypted fallback with a loud warning).
- **Encrypt `snapshots.data` and `staging.desired`** at rest with the keychain-sealed key.
- **Per-project token enforcement** on WebDAV paths; constant-time compare.
- **Control API auth**: bearer from `~/.envd/control.token`; file mode `0600`.
- **Structured logs** (JSON, rotated). Redaction guardrails — add a unit test that scans log output for values.
- **Linux mount adapter**: `davfs2` shell-out. Document the one-time package install.
- **Error codes**: exhaustive enum in `shared/errors.ts`; mapped to CLI exit codes; matched in tests.
- **Cache correctness**: coalesce concurrent reads; TTL tests.

Deliverable: security self-review checklist in a commit message, Linux smoke test passes in a container.

---

## M9 — DX polish

**Goal**: a new developer can get productive from `npm i -g` in under five minutes.

Tasks:
- `envd daemon install` — write a `launchd` plist for macOS and a `systemd --user` unit for Linux.
- `envd status` is useful: daemon, mount, project, staging, last fetch, provider health.
- Clear error messages for the failure modes that *actually* happen: mount missing, daemon not running, provider creds expired, Doppler 429, bad `.env` on `PUT`.
- A single `README.md` (project root) walking a user through install → init → edit → commit.
- `CHANGELOG.md` starts here; docs audit.

Deliverable: a ~3-minute screencast of the happy path.

---

## Decisions to pin before M0 lands

- WebDAV library vs. hand-rolled: try `webdav-server@v2` first. If it doesn't cleanly let us plug a virtual filesystem that reads from our registry/providers, drop to implementing the verbs over `node:http`. Budget one day to evaluate.
- Fastify vs. `node:http` for the control API: `node:http` is fine — the control API surface is small, and the daemon shouldn't drag in a framework.
- `better-sqlite3` vs. `libsql`: `better-sqlite3`. Native, sync API is a feature for our use case, and it's battle-tested.
- `keytar` is unmaintained-but-works. Plan to replace with a thin wrapper that shells out to `security`/`secret-tool` on the respective platforms.

## Non-goals during v0.1

- Performance tuning beyond "reads are sub-100 ms when cached, sub-2 s when cold."
- Multi-user / shared-state scenarios.
- Windows.
- Anything beyond the `secrets` data kind.
- An HTTP API that isn't `127.0.0.1`.
