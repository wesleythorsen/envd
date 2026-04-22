# Work breakdown — user stories, tasks, and dependency order

This doc decomposes [implementation-plan.md](implementation-plan.md) into **user stories** that:

- Can be committed independently without breaking `npm run check` or `npm run build`.
- Produce a vertical slice of working behavior (even if trivial).
- Fit into the head of a Sonnet- or Haiku-class agent given just this story + the referenced docs.

Each story has:

- **Goal** — plain-English outcome.
- **Acceptance criteria** — what "done" looks like; these are the agent's checklist.
- **Tasks** — smaller units (not independently committable; think "minutes of work" each).
- **Depends on** — other story IDs that must be done first.
- **Notes for the executing agent** — gotchas, pitfalls, and guidance where a lesser model might go astray.

## How to use this doc (for the orchestrator / for yourself)

1. Stories are grouped into **waves**. Stories **within a wave** can run in parallel. Stories in wave N require all their listed dependencies from waves ≤ N to be merged first.
2. When delegating to a sub-agent, hand it:
   - The story ID and this doc path.
   - [session-handoff.md](session-handoff.md), [architecture.md](architecture.md), and the spec doc matching the story (CLI vs daemon vs extension points).
   - An instruction to run `npm run check` before claiming completion.
3. Agents must **not** modify files outside what their story specifies without a brief justification in the PR/commit message.
4. Agents must keep dependencies minimal — only add an npm package if the story explicitly calls for it. If tempted to add more, stop and ask.

## Cross-cutting rules for all stories

These rules exist because a lesser model left to its own devices tends to over-engineer. Enforce them in sub-agent prompts.

- **Do not refactor unrelated code.** A single story touches a small set of files.
- **Do not add error handling for impossible cases.** Trust internal contracts. Validate at boundaries (CLI input, WebDAV body, control-API body, provider responses).
- **Do not write comments that restate the code.** Only comment non-obvious *why*.
- **Do not create new files unless the story lists them.** Prefer editing.
- **No `any`, no `as` casts** except at serialization boundaries with a one-line justification comment.
- **Every new module must have at least one unit test** if the story mentions testing; stories that don't mention tests can skip them.
- **Each commit ends with `npm run check` and `npm run build` both green.** Non-negotiable.
- **ESM only.** Always use `.js` in relative import specifiers for TS files (because `verbatimModuleSyntax` + Node ESM).
- **Small diffs.** If a story balloons past ~400 lines changed, stop and flag it — the decomposition was probably wrong.

---

## Wave 0 — Scaffolding (M0)

These establish the skeleton. Almost everything else depends on this wave. Keep them tiny.

### US-0.1 — CLI + daemon binaries wired up with a stub `version` command

**Goal.** Running `d-env version` prints a version string. Running `d-envd` starts a process that logs a line and exits on SIGTERM. The build produces two executables.

**Acceptance criteria.**
- `package.json` has `"bin": { "d-env": "dist/cli/main.js", "d-envd": "dist/daemon/main.js" }`.
- `src/cli/main.ts` exists and prints `{ cli: "<pkg version>" }` (JSON) on `version`.
- `src/daemon/main.ts` exists, logs `d-envd starting (version=<pkg version>, pid=<pid>)`, installs a SIGTERM handler, and exits cleanly.
- Both entrypoints start with a `#!/usr/bin/env node` shebang.
- `npm run build && node dist/cli/main.js version` prints the JSON.
- `npm run build && node dist/daemon/main.js &` runs, SIGTERM stops it cleanly.
- `npm run check` is green.

**Tasks.**
1. Add `commander` as a runtime dep; no other new deps.
2. Create `src/cli/main.ts` with a `commander` program, one `version` subcommand.
3. Create `src/daemon/main.ts` with a minimal `main()` that logs and waits on SIGTERM.
4. Update `package.json` `bin` and `files` fields; ensure `"bin"` points to built JS.
5. Add `chmod +x` behavior via a post-build step or by checking in the shebang (shebang alone is enough — `npm install` handles the mode when `bin` is declared).

**Depends on.** Nothing.

**Notes for the agent.**
- TS `rootDir` is `src`, `outDir` is `dist`. Don't fight the config.
- Read the version from `package.json` at runtime using `node:fs` or `import … with { type: "json" }`. If using import assertions in ESM, prefer `createRequire` for stability: `const pkg = require("../../package.json")` via `createRequire(import.meta.url)`. Either works; pick one and be consistent.
- Don't add a `help` command manually — commander provides one.

---

### US-0.2 — Shared `paths` module (state dir, ports, PID file, control token path)

**Goal.** One module owns all filesystem locations so no other code hardcodes paths.

**Acceptance criteria.**
- `src/shared/paths.ts` exports typed functions: `stateDir()`, `pidFile()`, `portsFile()`, `controlTokenFile()`, `logDir()`, `mountPath()` (platform-aware).
- Honors `D_ENV_HOME` env var override; defaults to `~/.d-env/`.
- Creates directories on demand via a helper `ensureStateDir()`.
- Unit tests cover the override and the default.

**Tasks.**
1. Add `os.homedir()` / `process.env.D_ENV_HOME` resolution.
2. Platform branch for `mountPath`: `/Volumes/d-env` (darwin), `~/.d-env/mount` (linux), throw on unsupported.
3. Tests in `test/unit/paths.test.ts` using a tmpdir and env manipulation.

**Depends on.** US-0.1 (needs the source tree).

**Notes for the agent.**
- Don't reach for `xdg-basedir` or similar packages; `node:os` + `node:path` is enough.
- Keep it synchronous. No async on path resolution.

---

### US-0.3 — Logger + error code enum

**Goal.** Structured logging with levels, and a single canonical `ErrorCode` enum used across CLI ↔ daemon.

**Acceptance criteria.**
- `src/shared/logger.ts` exports `createLogger(scope: string)` returning an object with `debug/info/warn/error` methods. Output is JSON per line to stderr when `D_ENV_LOG_FORMAT=json`, otherwise a concise human line.
- Respects `D_ENV_LOG_LEVEL` (`debug|info|warn|error`), default `info`.
- **Never logs secret values.** To make this enforceable, the logger accepts `{ msg, data }` where `data` is an object; there's **no positional variadic** API. Agents will have to serialize explicitly.
- `src/shared/errors.ts` exports `ErrorCode` (string-literal union), `DEnvError` class (extends `Error`, carries `code`, `details`, `cause`).
- Tests confirm redaction guardrails and JSON vs text formatting.

**Tasks.**
1. Logger implementation (no deps).
2. Error codes: start with `daemon_unreachable | usage_error | provider_unreachable | provider_auth | commit_conflict | mount_failed | not_initialized | internal | bad_dotenv | unauthorized`.
3. Test: assert JSON structure, level filtering, and `DEnvError` round-trip.

**Depends on.** US-0.1.

**Notes for the agent.**
- No `pino` / `winston` / etc. A 60-line handwritten logger is the point.
- The `data` object must NOT be a generic `Record<string, unknown>` — type it as `Record<string, string | number | boolean | null>` so an agent can't accidentally log a whole secrets object.

---

### US-0.4 — Vitest set up with one passing test

**Goal.** The test runner works so every subsequent story can add tests.

**Acceptance criteria.**
- `vitest` added as a dev dep.
- `vitest.config.ts` at repo root.
- `test/` is included; `node_modules`, `dist` excluded.
- `npm test` runs and passes.
- One trivial `test/unit/smoke.test.ts` that imports from `src/shared/paths.ts` and asserts `stateDir()` is a non-empty string.

**Depends on.** US-0.2 (needs `paths` to import in the smoke test).

**Notes for the agent.**
- Vitest works with our TS setup out of the box; no separate transform config needed.
- Ensure `npm run check` includes `vitest run --reporter=basic` or leave it out of `check` and rely on CI running `npm test`. For now, leave `check` alone; add `"test": "vitest run"` and `"test:watch": "vitest"` scripts.

---

## Wave 1 — Walking skeletons (M1 + M2 start)

These can run in parallel. They each prove a core assumption.

### US-1.1 — WebDAV server serving a single hardcoded file

**Goal.** The daemon exposes a WebDAV endpoint at `127.0.0.1:<port>` that returns `HELLO=world` for `GET /hello/.env`.

**Acceptance criteria.**
- `src/daemon/webdav/server.ts` exports `startWebdavServer(opts)` returning `{ port, close() }`.
- Binds to `127.0.0.1`; port 0 (ephemeral) accepted for tests; default from config or `1911`.
- `OPTIONS /` returns WebDAV headers (`DAV: 1`, `Allow: OPTIONS, PROPFIND, GET, HEAD`).
- `PROPFIND /` and `PROPFIND /hello` return valid WebDAV multistatus XML listing `/hello/.env`.
- `GET /hello/.env` returns `HELLO=world` with `Content-Type: text/plain; charset=utf-8` and `Last-Modified` set.
- `HEAD /hello/.env` matches `GET` headers.
- `d-envd` wires `startWebdavServer()` at boot and logs the port.
- Unit tests hit the server over loopback using `undici` and assert responses.

**Tasks.**
1. Evaluate `webdav-server@v2`. Budget: 30 minutes. If it cleanly exposes a custom filesystem with `readDir` / `openReadStream`, use it. If its API fights a dynamic in-memory layout, skip it and hand-roll.
2. Implement the server (either path).
3. Wire into `d-envd` `main()`.
4. Test: mount isn't tested here; only the HTTP surface.

**Depends on.** US-0.1, US-0.2, US-0.3.

**Notes for the agent.**
- **If you hand-roll**: implement only `OPTIONS`, `PROPFIND` (depth 0 and 1), `GET`, `HEAD`. No `PUT`/`LOCK` yet — those come in later stories. PROPFIND XML is the annoying part; look at RFC 4918 §9.1 and use a small template literal, not a dependency.
- `macOS mount_webdav` is picky: always set `Last-Modified`, `Content-Length`, and a non-chunked body. It also does an `OPTIONS *` early — respond with `DAV: 1, 2` to be safe.
- Do **not** bind to `0.0.0.0`. Always `127.0.0.1`.
- If `webdav-server@v2` has unresolved TypeScript issues, write a `src/types/webdav-server.d.ts` with a minimal shim rather than using `any`.

---

### US-1.2 — macOS mount adapter

**Goal.** Programmatically mount and unmount a WebDAV URL on macOS using built-in `mount_webdav`.

**Acceptance criteria.**
- `src/mount/adapter.ts` defines the `MountAdapter` interface from [extension-points.md](extension-points.md).
- `src/mount/darwin.ts` implements it by shelling out to `mount_webdav` / `umount`.
- `isMounted(path)` inspects `mount` output (or `diskutil info`) rather than just checking `fs.stat` (which would be fooled by an empty dir).
- The adapter module is only imported on darwin — use a factory in `src/mount/index.ts` that picks the adapter based on `process.platform` and throws a `DEnvError { code: 'mount_failed' }` on unsupported platforms.
- Integration test gated on `process.platform === 'darwin'` (use `it.skipIf`): start the WebDAV server from US-1.1, mount it into a tmp `/Volumes/d-env-smoke-<pid>`, read `hello/.env`, assert content, unmount.

**Tasks.**
1. Shell-out helper that uses `node:child_process` `execFile` (not `exec`, to avoid shell injection), returns `{ stdout, stderr, code }`.
2. `mount(url, path)`: `mkdir -p` the mount point, call `mount_webdav -S -v d-env <url> <path>`, verify with `isMounted`.
3. `unmount(path)`: call `umount <path>`; retry once on `EBUSY`.
4. Integration test (skipped on non-macOS).

**Depends on.** US-1.1 (needs something to mount).

**Notes for the agent.**
- `mount_webdav` blocks until the mount responds to `OPTIONS`. The server must be up before you call it.
- On macOS 14+, `mount_webdav` may prompt for keychain; `-S` (suppress auth UI) is important. We're on plain HTTP loopback with no auth in this story.
- Do **not** write a polyfill for Linux in this story. Linux is US-8.3.

---

### US-2.1 — Control HTTP API skeleton (`/v1/health`, `/v1/version`)

**Goal.** The daemon exposes a second HTTP server for the CLI to talk to.

**Acceptance criteria.**
- `src/daemon/control/server.ts` exports `startControlServer(opts)`.
- Binds `127.0.0.1:<port>`; default `1910`.
- Endpoints: `GET /v1/health`, `GET /v1/version`. Both return JSON per [daemon-spec.md](daemon-spec.md).
- All requests require `Authorization: Bearer <token>` matching a value loaded from `paths.controlTokenFile()`. Missing/wrong token → 401 with `{ error: { code: "unauthorized" } }`. `GET /v1/health` is still auth-gated — no public endpoints in v1.
- Health/version tokens are asserted in unit tests (pass a generated token at startup, hit with/without it).
- Daemon boot generates a random token and writes it to `controlTokenFile()` with mode `0600` if the file doesn't exist.
- Wired into `d-envd` alongside the WebDAV server.

**Tasks.**
1. Use `node:http` directly. No Fastify.
2. Tiny router: a `Map<"VERB PATH", handler>`. Keep it obvious.
3. Token generation via `crypto.randomBytes(32).toString("hex")`.
4. Constant-time string compare (`crypto.timingSafeEqual`).
5. Test: `undici` calls with and without the token.

**Depends on.** US-0.1, US-0.2, US-0.3.

**Notes for the agent.**
- Don't JSON-parse the body here yet — these endpoints are GETs.
- Respond with `Content-Type: application/json; charset=utf-8` explicitly.
- Log the chosen port at info level.

---

### US-2.2 — IPC client for the CLI

**Goal.** The CLI has a typed wrapper for calling the control API.

**Acceptance criteria.**
- `src/ipc/control-client.ts` exports `createControlClient(opts?)` returning a typed client with methods per endpoint — initially only `health()` and `version()`.
- Reads the port from `paths.portsFile()` and the token from `paths.controlTokenFile()`.
- Returns a distinct error type (`DEnvError { code: "daemon_unreachable" }`) on ECONNREFUSED — distinguish it from other errors so the CLI can special-case it.
- Uses `undici` with a short default timeout (2s for these two endpoints).
- Tests use `startControlServer()` from US-2.1 in-process to verify end-to-end.

**Tasks.**
1. Add `undici` dependency.
2. Implement client.
3. Tests: happy path, wrong token, bad host/port, server down.

**Depends on.** US-2.1.

**Notes for the agent.**
- Keep the client **stateless**. Each call opens its own connection. We don't need pooling for CLI use.
- Don't create a giant "API types" file yet — types live next to the client, grow as endpoints are added.

---

## Wave 2 — Daemon lifecycle + smoke test

### US-1.3 — End-to-end smoke test script

**Goal.** A script that starts the daemon, mounts the WebDAV volume on macOS, reads the hardcoded `.env`, asserts, unmounts, stops the daemon.

**Acceptance criteria.**
- `scripts/smoke-macos.ts` (runnable with `tsx`).
- `package.json` script `"smoke:macos": "tsx scripts/smoke-macos.ts"`.
- Uses the darwin mount adapter and the in-process daemon from US-1.1.
- Exits non-zero with a clear message on any step failure.
- CI-unfriendly (needs real macOS + `/Volumes` write perms) — documented in the script header.

**Depends on.** US-1.1, US-1.2.

**Notes for the agent.**
- Prefer ephemeral mount paths like `/Volumes/d-env-smoke-<pid>` so the script can be rerun without cleanup.
- Always unmount in a `finally`. A stuck mount is painful to clean up.

---

### US-2.3 — CLI daemon lifecycle commands

**Goal.** `d-env daemon start|stop|status|restart` works.

**Acceptance criteria.**
- Commands defined in `src/cli/commands/daemon.ts`.
- `start` spawns `d-envd` as a detached child (`child_process.spawn` with `{ detached: true, stdio: "ignore" }`), unrefs, writes PID, exits 0. Idempotent: if already running, prints a message and exits 0.
- `stop` reads PID, calls control-API `POST /v1/shutdown` (add this endpoint as part of this story), waits up to 5s for the process to exit, falls back to SIGTERM, then SIGKILL. Idempotent: if not running, exits 0.
- `status` shows: running?, PID, ports, daemon version, uptime.
- `restart` = stop + start with a small settle delay.
- Integration test: `start`, `status`, `stop`, `status` — assert transitions.

**Tasks.**
1. Extend control API with `POST /v1/shutdown` (204 response; actually closes listeners and exits).
2. Extend IPC client with `shutdown()`.
3. Implement the four commands.
4. PID-file lifecycle: write on daemon start, delete on graceful shutdown, clean up stale file on startup if the PID doesn't exist.

**Depends on.** US-2.1, US-2.2, US-0.2.

**Notes for the agent.**
- Detach correctly — if the parent process blocks on the child's stdio, the CLI never returns.
- Don't `console.log` from the daemon to the CLI's stdio; daemon logs go to files/stderr of the detached process.
- Stale PID detection: try `process.kill(pid, 0)`. ESRCH means dead.

---

## Wave 3 — State store groundwork

### US-3.1 — SQLite state store + migration framework

**Goal.** A small, testable migration runner over `better-sqlite3`.

**Acceptance criteria.**
- `src/core/state.ts` exports `openState(path)` returning a typed `StateStore` object with a `db` handle and `close()`.
- `src/core/migrations/` contains numbered `.ts` files: `0001_init.ts`, etc. Each exports `{ up(db): void }`.
- `openState()` applies pending migrations inside a transaction and records them in a `_migrations` table.
- `0001_init.ts` creates the `_migrations` table only (schema bits for projects etc. go in later stories).
- Tests: fresh db gets all migrations; reopening is a no-op; a broken migration is rolled back cleanly.

**Depends on.** US-0.1, US-0.2.

**Notes for the agent.**
- `better-sqlite3` is synchronous. That's a feature here — use it.
- Migration files are discovered by import (explicit list in `src/core/migrations/index.ts`). No glob-based dynamic loading; keeps the bundle honest and types clean.
- Always run migrations inside `db.transaction(() => { ... })()`.

---

## Wave 4 — Project registry

### US-3.2 — `projects` table + project repository

**Goal.** In-process API for creating, reading, listing, and deleting projects.

**Acceptance criteria.**
- New migration `0002_projects.ts` creates the `projects` table per [daemon-spec.md](daemon-spec.md) (skip the `provider_instance_id` column for now; add it in US-4.4's migration).
- `src/core/project.ts` exports a `ProjectRepo` with `create(input)`, `get(id)`, `getByToken(id, token)`, `list()`, `delete(id)`. Pure SQL, no HTTP.
- `create()` generates `id` (UUID v4) and `token` (32-byte hex).
- Validates `path` is absolute and exists; throws `DEnvError { code: "usage_error" }` otherwise.
- Unit tests for each method with an in-memory SQLite DB.

**Depends on.** US-3.1.

**Notes for the agent.**
- Use `crypto.randomUUID()` — no uuid package.
- `getByToken` is the one the WebDAV server will call on every read — make the SQL a prepared statement.

---

### US-3.3 — Control API: `/v1/projects` endpoints

**Goal.** CLI can create/read/list/delete projects over HTTP.

**Acceptance criteria.**
- `POST /v1/projects` — body `{ path }` (no provider bits yet). Returns `{ id, token, mountPath }` where `mountPath` is `<OS mount path>/p/<id>.<token>/.env`.
- `GET /v1/projects` — list.
- `GET /v1/projects/:id` — detail.
- `DELETE /v1/projects/:id` — remove. Returns 204.
- Body parsing: a small `src/daemon/control/body.ts` reads JSON with a size cap (64KB) and rejects non-JSON.
- Tests hit each endpoint through the control-API server with auth.

**Depends on.** US-2.1, US-3.2.

**Notes for the agent.**
- All paths validated against path traversal — normalize with `path.resolve()` and reject if it escapes a safe root. For v1 the "safe root" is just "must be absolute and exist"; no escape vectors because the daemon doesn't write to it.

---

### US-3.4 — WebDAV routes driven by the project registry

**Goal.** Replace the hardcoded `/hello/.env` with `/p/<id>.<tok>/.env` served from the registry; content is still a placeholder.

**Acceptance criteria.**
- Remove `/hello/.env`.
- `GET /p/<id>.<tok>/.env` returns `# d-env project <id>\n# staged at: <timestamp>\n`.
- `PROPFIND /` lists `/p/` as a directory; `PROPFIND /p/` lists all projects' subpaths; `PROPFIND /p/<id>.<tok>/` lists `.env`.
- Mismatched token → `404` (not 401/403; avoid enumeration).
- Unknown id → `404`.
- Unit tests for each case.

**Depends on.** US-1.1, US-3.2.

**Notes for the agent.**
- Constant-time token comparison.
- The daemon must get an injected `ProjectRepo`; don't open the DB inside the HTTP handler.

---

## Wave 5 — CLI project commands

### US-3.5 — `d-env init` (minimum viable)

**Goal.** `d-env init` in a fresh directory registers the project, creates the symlink, writes `.d-env.json`, and ensures the mount exists.

**Acceptance criteria.**
- Prompts for confirmation (unless `--yes`); no provider prompts yet (those come in US-4.10).
- Creates the mount if missing (on macOS).
- Calls `POST /v1/projects` with the current dir.
- Writes `./.d-env.json` with `{ projectId, version: 1 }`. The token is **not** stored here — it lives only in the daemon state.
- Creates `./.env` symlink pointing to the mount path.
- Adds `.env` to `.gitignore` if not already listed (creates `.gitignore` if missing).
- Idempotent: re-running finds the existing `.d-env.json`, verifies the daemon still has the project, recreates the symlink if missing, and exits 0 with a status summary.
- Integration test: start daemon, init in a tmpdir, assert symlink target + registry entry.

**Depends on.** US-1.2, US-2.3, US-3.3.

**Notes for the agent.**
- Symlink creation: `fs.symlinkSync(target, path)`. Handle `EEXIST` by stat-checking the existing path — only replace if it's a symlink we own.
- **Do not** write the project token to `.d-env.json`. That file may be committed by mistake; the token should never be there. The CLI fetches the symlink target fresh from the daemon on each `link` instead.
- If the mount doesn't exist and the user's on Linux, print a helpful message pointing to the (unfinished) Linux support story and exit non-zero.

---

### US-3.6 — `d-env status`

**Goal.** A quick "is everything working?" readout.

**Acceptance criteria.**
- Without a project context: shows daemon health, mount status.
- Inside an initialized project dir: adds project id, symlink target, whether the registry has the project, last fetch time (N/A until providers land).
- `--json` output path.
- Tests cover both contexts.

**Depends on.** US-3.5.

---

### US-3.7 — `d-env link` / `d-env unlink`

**Goal.** Repair-or-remove flow for teams cloning a repo that already has `.d-env.json`.

**Acceptance criteria.**
- `link`: reads `.d-env.json`, asks daemon for the project's mount path, creates the symlink. If the daemon doesn't know the project, error with guidance (`this project needs to be re-initialized on this machine with 'd-env init'`).
- `unlink`: removes the symlink. `--purge` also deletes the project from the daemon registry (uses `DELETE /v1/projects/:id`).
- Tests cover both.

**Depends on.** US-3.5.

---

## Wave 6 — Provider abstraction + `local-file` provider

Many of these parallelize.

### US-4.1 — Provider / DataKind / Mount interfaces

**Goal.** The type shapes from [extension-points.md](extension-points.md) exist in code.

**Acceptance criteria.**
- `src/providers/base.ts` has `Provider`, `ProviderInstance`, `ProviderContext`, `SecretMap`, `ChangeSet`, `PushResult`.
- `src/kinds/secrets/index.ts` exports a `DataKind` implementation for secrets (parse/render/diff/merge).
- `src/mount/adapter.ts` has `MountAdapter` interface.
- No implementations yet beyond what's already present. Interfaces only.
- Types compile standalone (no `any`, no circular imports).

**Depends on.** US-0.1.

**Notes for the agent.**
- Keep `SecretMap` readonly (`Readonly<Record<string, string>>`).
- Explicitly define `PushResult` as a discriminated union on `status`.
- `DataKind` generics: don't over-parameterize; secrets' concrete types can inline.

---

### US-4.2 — Provider registry

**Goal.** A single explicit list of available providers.

**Acceptance criteria.**
- `src/providers/registry.ts` exports `providers: readonly Provider[]` — a hand-maintained array.
- A lookup helper `findProvider(name)` returns `Provider | undefined`.
- For now the array is empty (`[]`). US-4.3 adds `local-file`. US-5.x adds Doppler.

**Depends on.** US-4.1.

**Notes for the agent.**
- Do **not** add dynamic plugin loading, directory scanning, or config-based registration. Explicit list only.

---

### US-4.3 — `local-file` provider

**Goal.** A file-backed provider usable for tests and offline dev.

**Acceptance criteria.**
- `src/providers/local-file/index.ts` exports a `Provider` whose instance reads/writes a JSON file (path from instance config).
- `fetch()` reads the file; missing file → treat as empty map, not error.
- `push(changes)` applies upserts and deletes, writes atomically (`tmp + rename`).
- `test()` checks the file is readable (or the parent dir is writable if the file doesn't exist).
- Unit tests cover: empty file, missing file, push adding + deleting keys, concurrent-push safety (sequential, but don't corrupt the file on crash).

**Depends on.** US-4.1, US-4.2.

**Notes for the agent.**
- Atomic write: write to `<path>.tmp-<pid>`, `fs.renameSync` over target. Guarantees POSIX atomicity.
- File format: top-level JSON object, keys strings, values strings. Reject anything else with `DEnvError { code: "provider_unreachable" }` + `cause`.

---

### US-4.4 — `provider_instances` table and project wiring

**Goal.** Projects carry a provider-instance FK.

**Acceptance criteria.**
- New migration `0003_provider_instances.ts` creates `provider_instances` per [daemon-spec.md](daemon-spec.md) and adds `provider_instance_id` nullable column to `projects`. `ALTER TABLE ADD COLUMN` is fine at this stage.
- `ProviderInstanceRepo` with `create/list/get/delete`. `delete` refuses if any project references the instance.
- `ProjectRepo.create()` accepts an optional `providerInstanceId` (for backwards compat with US-3.5 flows that didn't prompt yet).

**Depends on.** US-3.2, US-4.1.

---

### US-4.5 — Control API: `/v1/providers` and `/v1/provider-instances`

**Goal.** Provider CRUD over the control API.

**Acceptance criteria.**
- `GET /v1/providers` — returns metadata for each registered provider: `{ name, instanceConfigSchema, credentialKeys }`.
- `POST /v1/provider-instances` — body `{ provider, name, config, credentials }`. Credentials are accepted in the request body, immediately handed to the keychain adapter, and never persisted. Response: `{ id }`.
- `GET /v1/provider-instances` / `GET /v1/provider-instances/:id` / `DELETE /v1/provider-instances/:id`.
- `POST /v1/provider-instances/:id/test` — returns the provider's `test()` result.
- Add a stub `KeychainAdapter` now (US-5.1 finalizes it) — for this story, store credentials in memory with a loud `TODO` log.
- Tests exercise the flow end-to-end with the `local-file` provider (which has `credentialKeys: []`, so no keychain needed yet).

**Depends on.** US-4.2, US-4.3, US-4.4.

---

### US-4.6 — CLI: `d-env provider list/add/remove/test`

**Goal.** Interactive CLI for managing provider instances.

**Acceptance criteria.**
- `list` — prints registered providers and configured instances.
- `add` — interactive prompts driven by the provider's `instanceConfigSchema` (supports `string`, `boolean`, `enum` for v1). Credentials prompted separately, masked.
- `remove <id>` — confirms; calls `DELETE`.
- `test <id>` — calls test endpoint and prints result.
- Tests for non-interactive `--config-json` and `--credentials-json` flags (used by CI and by other stories).

**Depends on.** US-4.5.

**Notes for the agent.**
- Use `node:readline` and manual TTY handling rather than `inquirer`. Three prompt types are not worth a dep.
- Masked input: set `process.stdin.setRawMode(true)` and buffer chars without echo. There's plenty of 30-line examples online; keep it short.

---

### US-4.7 — Cache layer with TTL and coalescing

**Goal.** Per-project snapshot cache so reads don't hammer providers.

**Acceptance criteria.**
- `src/core/cache.ts` exports `createCache(opts)` returning `{ get(projectId, fetcher), invalidate(projectId) }`.
- Each entry has a value, `fetchedAt`, and a pending-promise slot.
- Concurrent `get()` calls during a pending fetch await the same promise (coalescing).
- TTL configurable per call (the caller passes it — keep the cache dumb).
- Memory-only; no persistence (that's US-8.1's encrypted snapshots).
- Tests cover: fresh fetch, within-TTL hit, after-TTL refetch, coalescing, `invalidate`.

**Depends on.** US-0.1.

**Notes for the agent.**
- Don't reach for `lru-cache`. It's a `Map` with timestamps.
- Make sure `invalidate` also rejects an in-flight promise path cleanly — or just leaves it alone (the inflight completes, but the next `get` refetches). Pick one explicitly and test for it.

---

### US-4.8 — `.env` parser + renderer

**Goal.** Bi-directional converter between `SecretMap` and `.env` bytes.

**Acceptance criteria.**
- `src/core/rendering/dotenv.ts` exports `parse(bytes, opts): SecretMap` and `render(map, opts): Uint8Array`.
- Round-trip: `parse(render(x)) === x` for any valid map (when using the same opts).
- Supports: unquoted, single-quoted, double-quoted values; escapes `\n`, `\r`, `\t`, `\\`, `\"` inside double quotes; preserves literal text inside single quotes; trims trailing whitespace.
- Tolerant on parse: ignores blank lines and `#` comments.
- Rejects duplicate keys in parse with a `DEnvError { code: "bad_dotenv" }`.
- Render opts: `quote: "always" | "when-needed"`, `sortKeys: "alphabetical" | "insertion"`.
- Extensive unit tests covering edge cases: newlines in values, unicode, empty values, keys with dots, RFC-violating inputs.

**Depends on.** US-0.1.

**Notes for the agent.**
- **Don't** use `dotenv` the npm package. Its parser is too permissive for our round-trip guarantee.
- Look at the dotenv-expand spec for reference on quoting, but don't copy its expansion behavior; we do **not** interpolate `${...}`. We treat all values as opaque strings.
- Write the tests *first*. This is a module where a lesser model will otherwise converge on "looks right for a few cases, wrong for the rest."

---

### US-4.9 — Wire WebDAV `GET` to provider + renderer + cache

**Goal.** End-to-end read path: WebDAV GET → project → provider → cache → renderer → response.

**Acceptance criteria.**
- Replace the placeholder content in WebDAV `GET /p/<id>.<tok>/.env` with a real render:
  1. Resolve project.
  2. Look up provider instance.
  3. `cache.get(projectId, () => instance.fetch())`.
  4. `secretsKind.render(map, project.formatConfig)`.
  5. Return with `ETag` = sha256 of bytes, `Last-Modified` = cache `fetchedAt`.
- Support `If-None-Match` → `304`.
- If `instance.fetch()` throws, return 503 with `X-DEnv-Error: provider_unreachable`.
- Integration test: `local-file` provider with a JSON fixture, end-to-end read returns expected `.env` bytes.

**Depends on.** US-3.4, US-4.3, US-4.7, US-4.8.

**Notes for the agent.**
- Store `formatConfig` on the project record — default to `{ quote: "when-needed", sortKeys: "alphabetical" }`. Adding the column here (migration 0004) is OK.
- Cache TTL: read from provider-instance config, default 60s.

---

### US-4.10 — `d-env init` prompts for provider instance

**Goal.** Init walks the user through picking or creating a provider instance.

**Acceptance criteria.**
- If no provider instances exist: prompts to create one via the provider-add flow.
- If one or more exist: asks the user to pick or create new.
- `POST /v1/projects` now carries the chosen `providerInstanceId`.
- Non-interactive flags: `--provider-instance <id>` and `--provider <name>` (+ config/credentials flags to auto-create) for scripting.
- Integration test for both interactive (scripted input) and non-interactive modes.

**Depends on.** US-3.5, US-4.6, US-4.9.

---

## Wave 7 — Doppler provider

### US-5.1 — Keychain adapter

**Goal.** A real `KeychainAdapter` that stores provider credentials in the OS keychain on macOS, with a clear fallback path on Linux.

**Acceptance criteria.**
- `src/core/keychain.ts` exports a `KeychainAdapter` with `set(service, account, secret)`, `get(service, account)`, `delete(service, account)`.
- macOS impl shells out to the `security` CLI — don't adopt `keytar` unless there's a strong reason.
- Linux impl: shell out to `secret-tool` if present; otherwise encrypted-file fallback at `~/.d-env/secrets.enc` sealed with an age key stored in-memory only for the daemon lifetime. Document the limitation in the fallback path.
- Replace the in-memory stub from US-4.5.
- Unit tests: mock `child_process` for the shell-out paths; real-keychain tests gated on platform + env var `D_ENV_TEST_KEYCHAIN=1`.

**Depends on.** US-4.5.

**Notes for the agent.**
- `security add-generic-password -s <svc> -a <acct> -w <secret> -U`. `-U` means update if present.
- Never pass secrets on an argv — write them to a tempfile and pass `-w @tempfile`. Actually, `security` doesn't support `@` for `-w`; the only safe path is to use `security` with `-w -` and stdin. Verify this when writing; if `security` only accepts the secret via argv, use a detached `spawn` where the secret is in the env var `D_ENV_SECRET` and invoke a one-line shell wrapper that `exec`s `security` with the value. Prefer stdin.

---

### US-5.2 — Doppler provider `fetch()`

**Goal.** Reading from a real Doppler project works.

**Acceptance criteria.**
- `src/providers/doppler/index.ts` implements `fetch()` calling Doppler's `v3/configs/config/secrets/download?format=json`.
- Instance config: `{ project: string; config: string; apiHost?: string }`.
- Credentials: `{ apiToken: string }`.
- Error shapes: 401/403 → `provider_auth`; 429 → `provider_unreachable` with `details.retryAfter`; 5xx → `provider_unreachable`; parse failure → `provider_unreachable` with `cause`.
- MSW-backed tests for happy path + each error class.

**Depends on.** US-4.1, US-5.1.

**Notes for the agent.**
- Don't drag in the `@dopplerhq/...` SDK; plain `fetch` + the documented REST endpoint is simpler and keeps our dep surface honest.
- Doppler's download endpoint returns a JSON object of `{ KEY: "value" }` — that matches our `SecretMap` directly.

---

### US-5.3 — Doppler provider `push()`

**Goal.** Writing back to Doppler works.

**Acceptance criteria.**
- Uses Doppler's `v3/configs/config/secrets` PATCH/POST endpoint (verify current API in docs at implementation time).
- Maps `ChangeSet.upserts` to secret updates, `ChangeSet.deletes` to explicit deletes.
- On partial failure returns `{ status: "conflict", remote: <fresh fetch> }` so the daemon's commit flow can re-drive.
- MSW test: happy path + partial-failure path.

**Depends on.** US-5.2.

**Notes for the agent.**
- Re-fetch after push to verify. Don't trust the response echo alone.

---

### US-5.4 — Doppler provider `test()`

**Goal.** `d-env provider test <id>` confirms creds work.

**Acceptance criteria.**
- Cheap call to `v3/me` (or the current equivalent).
- Returns `{ ok: true }` or `{ ok: false, reason }`.
- MSW tests.

**Depends on.** US-5.2.

---

## Wave 8 — Write path (staging)

### US-6.1 — `staging` table + repository

**Goal.** The data shape for unpushed edits.

**Acceptance criteria.**
- Migration adds `staging` per [daemon-spec.md](daemon-spec.md). (Use a plain TEXT column for `desired`; encryption comes in US-8.1.)
- `StagingRepo` with `getDesired(projectId)`, `setDesired(projectId, map)`, `clear(projectId)`.
- Tests cover set/get/clear.

**Depends on.** US-3.1.

---

### US-6.2 — WebDAV `PUT` handler stages the new desired state

**Goal.** Saving the virtual `.env` from an editor stages a change.

**Acceptance criteria.**
- Support `PUT /p/<id>.<tok>/.env`.
- Parse body with the `.env` parser (US-4.8); on bad input return `400` + `X-DEnv-Error: bad_dotenv`.
- Overwrite the project's staging (full-replace semantics — the PUT represents the desired final state).
- Return `204`.
- Integration test: mount in-memory WebDAV via `undici`, PUT a `.env`, assert staging in the DB matches.

**Depends on.** US-4.8, US-4.9, US-6.1.

**Notes for the agent.**
- Add `PUT` to the `OPTIONS` response's `Allow` header.
- Also accept `MKCOL` as a 405 (mount clients occasionally try it; don't 500).

---

### US-6.3 — Merge staging onto the remote snapshot on read

**Goal.** After a PUT, subsequent GETs show the merged view.

**Acceptance criteria.**
- `GET` reads provider snapshot via cache, then applies staged map (full replace of the value set — staging is the desired final state, not a delta).
- Render that merged map.
- Integration test: fetch via `local-file` provider, stage some edits, GET returns edits.

**Depends on.** US-6.2.

**Notes for the agent.**
- Staging-as-full-desired-state is deliberate. It matches what the editor did ("save this as the new contents"). If you change semantics to "delta only," diff/commit gets much more complex.

---

### US-6.4 — Structured diff computation

**Goal.** A pure function that diffs two `SecretMap`s into `{ added, modified, deleted }` with values.

**Acceptance criteria.**
- `src/kinds/secrets/diff.ts` exports `diffSecrets(a, b)` returning a structured diff.
- Keys-only and with-values variants (CLI decides which to render).
- Unit tests for adds, mods, deletes, empty cases.

**Depends on.** US-4.1.

---

### US-6.5 — Minimal `LOCK` / `UNLOCK` support

**Goal.** Editors requesting WebDAV locks (macOS Finder, some IDEs) don't fail on save.

**Acceptance criteria.**
- `LOCK` returns a synthetic lock token; stored in an in-memory map keyed by path; expires after 30s.
- `UNLOCK` drops the token.
- Never blocks actual PUTs — locks are advisory in v1.
- Unit tests for token round-trip and timeout.

**Depends on.** US-6.2.

**Notes for the agent.**
- RFC 4918 §9.10 has the XML. A single template literal works. Don't pull in a WebDAV XML library.

---

### US-6.6 — Control API: `GET /v1/projects/:id/diff`

**Goal.** The CLI can fetch a structured diff.

**Acceptance criteria.**
- Returns `{ keys: { added: [], modified: [], deleted: [] } }` by default.
- `?values=true` includes values.
- Tests cover both modes.

**Depends on.** US-6.4.

---

### US-6.7 — CLI: `d-env diff`

**Goal.** Print the diff, git-style.

**Acceptance criteria.**
- Keys-only by default with `+`/`~`/`-` prefixes.
- `--values` reveals values.
- `--json` structured output.
- TTY color via a tiny helper (don't add `chalk`).
- Tests for each output mode using a stubbed control-API client.

**Depends on.** US-6.6.

---

## Wave 9 — Commit / pull

### US-7.1 — Control API: `POST /v1/projects/:id/commit`

**Goal.** Push staging to the provider with conflict detection.

**Acceptance criteria.**
- Body: `{ message?, strategy: "abort" | "theirs" | "ours" }`. Default `abort`.
- Flow: force-refresh provider fetch → diff staging vs. fresh → detect conflicts (keys that both moved) → apply strategy → call `provider.push()` → on `ok`, clear staging and invalidate cache.
- On `abort` strategy + conflict: returns 409 with a structured conflict payload.
- Returns `{ applied: ChangeSet, commitId?: string }` (commitId reserved; can be null in v1).
- Integration tests: happy path, conflict with each strategy, push failure.

**Depends on.** US-5.3 (or any `push()`-implementing provider), US-6.3.

---

### US-7.2 — Control API: `POST /v1/projects/:id/pull`

**Goal.** Drop staging and refresh from remote.

**Acceptance criteria.**
- Body: `{ force?: boolean }`. With non-empty staging and `force !== true` → 409 with a clear error.
- Clears staging, invalidates cache, re-fetches.
- Returns `{ snapshotFetchedAt }`.
- Tests.

**Depends on.** US-6.3.

---

### US-7.3 — CLI: `d-env commit`

**Goal.** `d-env commit -m "..."` works end-to-end.

**Acceptance criteria.**
- Flags: `-m / --message`, `--theirs`, `--ours`, `--json`, `--yes` (skip the "about to push these keys:" confirmation).
- Interactive default: prints a summary diff, asks for confirm, calls commit endpoint.
- On conflict without strategy: prints the conflict and exits non-zero with guidance.
- Integration tests via a fake control server.

**Depends on.** US-7.1.

---

### US-7.4 — CLI: `d-env pull`

**Goal.** `d-env pull [--force] [--dry-run]`.

**Acceptance criteria.**
- `--dry-run` prints what *would* change, doesn't call pull endpoint (or calls a dry-run variant — simpler: CLI just fetches staging+snapshot diff, prints, doesn't call pull).
- `--force` required when staging is non-empty; CLI maps to endpoint body.
- Tests.

**Depends on.** US-7.2.

---

## Wave 10 — Hardening (M8)

These are parallelizable among themselves once the preceding waves land.

### US-8.1 — Encrypt snapshots and staging at rest

- New daemon key (32 bytes) stored via keychain adapter on first boot.
- `XChaCha20-Poly1305` or `aes-256-gcm` — whichever is available with zero deps. Node has `crypto.createCipheriv("aes-256-gcm")` — use that.
- Wrap `SnapshotRepo` and `StagingRepo` with transparent seal/unseal.
- Migration-driven re-encryption of any pre-existing rows (there shouldn't be any at v0.1 rollout; still write the migration defensively).
- Tests for seal/unseal round-trip and for decryption failure (tampered rows → fail loudly).

**Depends on.** US-5.1, US-6.1, snapshot rows wherever they get introduced (probably US-4.9's cache persistence, if we add it; otherwise just staging).

---

### US-8.2 — Per-project token enforcement (hardening pass)

- Audit every WebDAV handler for a missing constant-time token check.
- Add a helper `requireProjectAuth(url) → project` used everywhere.
- Fuzz test: random bogus paths → consistent 404 behavior, no timing leak (roughly; this isn't a remote attacker, but be disciplined).

**Depends on.** US-3.4 and all WebDAV stories.

---

### US-8.3 — Linux mount adapter

- `src/mount/linux.ts` implementing `MountAdapter` via `davfs2` (`mount.davfs`).
- Detection: refuse to run if `davfs2` not installed; print a one-line install hint (`apt install davfs2` / `dnf install davfs2`).
- Integration test in a Debian container (document the command; don't require it in local `npm test`).

**Depends on.** US-1.2 (for the interface).

**Notes for the agent.**
- `davfs2` typically wants an entry in `/etc/davfs2/secrets` for auth. For our loopback-no-auth case, you can skip auth, but you may need `use_locks 0` in the config to avoid it trying to write to a shared dir. Document whatever you find.

---

### US-8.4 — Log file output + rotation

- `~/.d-env/logs/d-envd.log` as the default log sink when daemon is detached.
- Simple size-based rotation (5MB × 5 files), no dependency.
- Add `GET /v1/logs?tail=N` and `?follow=true` (SSE) for `d-env daemon logs`.

**Depends on.** US-0.3, US-2.1.

---

### US-8.5 — Log redaction guardrail test

- A test that fuzzes the WebDAV + control paths with unusual secret values (`password=hunter2`, `KEY="with \"quotes\""`, etc.), captures log output, and asserts no value appears in it.
- Where there's a risk — e.g. a generic `logger.error(err)` might include a provider response body — add explicit redaction or refuse to log.

**Depends on.** All WebDAV/control stories merged.

---

### US-8.6 — Cache correctness tests under concurrency

- Spawn N concurrent GETs against an expired cache entry with a slow provider stub; assert exactly one provider fetch.
- Invalidate race: start a GET, invalidate mid-flight, start another GET; assert both complete with consistent data.

**Depends on.** US-4.7, US-4.9.

---

## Wave 11 — DX polish (M9)

### US-9.1 — `d-env daemon install|uninstall` (launchd)

- Writes `~/Library/LaunchAgents/com.d-env.daemon.plist`.
- `launchctl load/unload`.
- Tests on macOS only; gated.

**Depends on.** US-2.3.

---

### US-9.2 — `d-env daemon install|uninstall` (systemd --user)

- `~/.config/systemd/user/d-envd.service`.
- `systemctl --user enable/start/disable/stop`.
- Gated on linux.

**Depends on.** US-2.3.

---

### US-9.3 — Rich `d-env status`

- Merges daemon + mount + project + staging + last-fetch + provider-health into one readable block.
- `--json` supports the same data.

**Depends on.** US-3.6, US-4.9, US-6.3.

---

### US-9.4 — Error-message audit

- Walk through the `ErrorCode` enum. For every code, ensure the CLI prints a clear, actionable message with at least one "what to try" hint.
- Snapshot tests for each code's CLI output.

**Depends on.** All prior CLI stories.

---

### US-9.5 — README + CHANGELOG

- Project root `README.md` with install → init → edit → commit walkthrough.
- `CHANGELOG.md` seeded with `0.1.0` entry.
- Link to `docs/` index.

**Depends on.** Everything.

---

## Dependency graph (compact)

```
0.1 → 0.2 → 0.3, 0.4 → 0.5
0.1 ──────────────────────────┐
                              ▼
   1.1 ─────────┐    2.1 → 2.2 → 2.3
   1.2 ────────▶│
                │
                └─▶ 1.3

3.1 → 3.2 → 3.3
         └─▶ 3.4  (also needs 1.1)
                ─▶ 3.5 (needs 1.2, 2.3, 3.3) → 3.6, 3.7

4.1 → 4.2 → 4.3
4.4 (needs 3.2, 4.1)
4.5 (needs 4.2, 4.3, 4.4)
4.6 (needs 4.5)
4.7 (independent, needs 0.x)
4.8 (independent, needs 0.x)
4.9 (needs 3.4, 4.3, 4.7, 4.8)
4.10 (needs 3.5, 4.6, 4.9)

5.1 (needs 4.5)
5.2, 5.3, 5.4 (need 4.1, 5.1)

6.1 (needs 3.1)
6.2 (needs 4.8, 4.9, 6.1)
6.3 (needs 6.2)
6.4 (needs 4.1)
6.5 (needs 6.2)
6.6 (needs 6.4)
6.7 (needs 6.6)

7.1 (needs 5.3 or any push() impl, 6.3)
7.2 (needs 6.3)
7.3 (needs 7.1)
7.4 (needs 7.2)

8.x, 9.x — parallel within-wave; see per-story deps.
```

## Parallelism rules of thumb for the orchestrator

- **Never** run two stories that touch the same migration number concurrently. Serialize migration-adding stories.
- **Never** run two stories that edit the same file beyond ~10 lines concurrently. If two stories both say "edit `src/cli/main.ts`," run them sequentially.
- Prefer finishing each wave fully before kicking off the next; cross-wave interleaving is only worth it when a later story has no dep on the incomplete earlier ones.

## Handoff prompt template for sub-agents

When delegating a story to a Sonnet sub-agent, use approximately this shape:

```
You're implementing user story <US-X.Y> for the d-env project.

Context:
- Repo: /Users/WThorsen/repos/github.com/wesleythorsen/d-env
- Read first: docs/session-handoff.md (cold-start brief)
- Spec docs relevant to this story: <pick from cli-spec.md, daemon-spec.md,
  extension-points.md based on story>
- This story's definition: docs/work-breakdown.md (search for <US-X.Y>)

Rules:
- Follow the cross-cutting rules at the top of docs/work-breakdown.md.
- Do NOT modify files outside what the story specifies.
- Do NOT add npm dependencies not called out in the story.
- Run `npm run check` and (if tests were added) `npm test` before you're done.
- Keep the diff small. If it balloons past ~400 lines, stop and summarize why.

Output:
- A short summary of what you changed, file by file.
- Any decisions you made where the story left room.
- Any blockers you hit. Do not silently work around a spec ambiguity — flag it.
```
