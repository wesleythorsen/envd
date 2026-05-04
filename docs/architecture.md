# Architecture

## Components

```
┌────────────────────────────┐         ┌────────────────────────────────────────┐
│ Developer's project        │         │ d-envd (long-running local daemon)     │
│                            │         │                                        │
│   ./src/app.ts ─ reads ─► .env  ───► │  ┌─ WebDAV server (127.0.0.1:NNNN) ─┐  │
│                    ▲                 │  │  GET /p/<project>/.env ──┐       │  │
│                    │ (symlink)       │  │  PUT /p/<project>/.env   │       │  │
│                    │                 │  └──────────────────────────│───────┘  │
│  /Volumes/d-env/…  │                 │                             ▼          │
│  (OS-mounted       │                 │  ┌─ Core ──────────────────────────┐   │
│   WebDAV share)  ──┘                 │  │  Project registry • State store │   │
│                            │         │  │  Provider abstraction • Cache   │   │
└────────────────────────────┘         │  │  .env render/parse • Staging    │   │
                                       │  └───────────┬─────────────────────┘   │
┌────────────────────────────┐         │              │                         │
│ d-env (CLI, short-lived)   │ ──────► │  ┌─ Control HTTP API (127.0.0.1) ──┐  │
│                            │ ◄────── │  │  /v1/projects, /v1/providers,   │  │
│  init / status / diff /    │         │  │  /v1/diff, /v1/commit, /v1/pull │  │
│  commit / pull / provider  │         │  └──────────────┬──────────────────┘  │
└────────────────────────────┘         │                 ▼                      │
                                       │        ┌─ Provider plugins ─┐          │
                                       │        │  doppler / aws /   │          │
                                       │        │  local-file / …    │          │
                                       │        └─────────┬──────────┘          │
                                       └──────────────────│─────────────────────┘
                                                          ▼
                                               Remote secrets backend
                                               (Doppler API, AWS SM, …)
```

### 1. CLI — `d-env`

- Short-lived Node process. Single binary entry: `bin/d-env`.
- Talks to the daemon over the **control HTTP API** for all stateful operations.
- The CLI never speaks to providers directly. It never reads or writes the state store directly. That keeps the daemon the single source of truth.
- Commands are defined in `src/cli/`. Parsing via `commander` (or similar). Output formatted as human-readable by default, `--json` for scripting.

### 2. Daemon — `d-envd`

- Long-running process, one per user session. Started on demand by the CLI (`d-env daemon start`) or on login via `launchd` (macOS) / `systemd --user` (Linux).
- Hosts two HTTP servers, both bound to `127.0.0.1`:
  - **WebDAV server** (default port `1911`, configurable). This is what the OS talks to when the mounted volume is accessed.
  - **Control API** (default port `1910`, configurable). This is what the CLI talks to.
- Ports are recorded in a runtime file so the CLI can discover them.
- Graceful shutdown: SIGTERM flushes the state store and releases the PID/port files. The mount is **not** unmounted by the daemon; the CLI has a separate `d-env unmount` for that.

### 3. OS mount

- macOS: `mount_webdav http://127.0.0.1:PORT/ ~/.d-env/mount` (built-in, no install). `/Volumes/d-env` can be used via config/override, but is not the default because creating `/Volumes/*` may require elevated permissions.
- Linux: `mount.davfs http://127.0.0.1:PORT/ ~/.d-env/mount` via the `davfs2` package. (Out-of-tree, but packaged in common distros.)
- The mount is established by the CLI on `d-env init` (if missing) and reused for every project afterward. The same mount hosts multiple projects under distinct paths.

### 4. Project symlink

- On `d-env link` (or the first `d-env init`), the CLI creates a symlink in the project directory:
  - `./.env -> ~/.d-env/mount/p/<project-id>/.env`
- The project ID is a UUID generated at init time. The mapping `project-id -> provider/config/naming` lives in the daemon's state store.
- **Per-project access token**: the path can optionally include a URL-safe token (e.g. `/p/<project-id>.<token>/.env`) so another local process can't enumerate `/p/` and read secrets. The symlink embeds the token; the daemon rejects requests with a wrong token. This is a v1 hardening — still only defense-in-depth, since loopback + file permissions are the main trust boundary.

### 5. State store

- Per-user directory: `~/.d-env/`
  - `state.db` — SQLite file: projects, provider configs (references, not secrets), staged changes, last-known snapshots, timestamps.
  - `secrets.enc` — encrypted blob for provider credentials that can't live in the OS keychain (fallback only). Primary store is OS keychain / libsecret.
  - `d-envd.pid`, `d-envd.ports` — runtime files.
  - `logs/` — rotating log files.
- SQLite is chosen over bespoke JSON so we can evolve the schema with migrations cleanly.

### 6. Provider abstraction

A provider is any module implementing a small interface (details in [extension-points.md](extension-points.md)). For v1 we ship:

- **`local-file`** — reads/writes a JSON file on disk. Used for tests, demos, and offline dev.
- **`doppler`** — calls the Doppler API.

Adding AWS Secrets Manager, Vault, or our own provider later is an additive change: implement the interface, register it, done.

## Data flow

### Read flow (app starts, reads `.env`)

1. App opens `./.env`. Symlink resolves to `~/.d-env/mount/p/<id>.<tok>/.env`.
2. macOS issues a `PROPFIND` then `GET` to the daemon's WebDAV server.
3. Daemon authenticates the path (project id + token), loads the project record.
4. Daemon asks the configured provider for the latest secrets. If a fresh-enough cached snapshot exists (TTL, default 60s), use that. Otherwise fetch.
5. Daemon applies any **staged changes** layered on top of the provider snapshot (so the developer sees their unpushed edits in-place).
6. Daemon renders `.env` text from the merged `(remote, staged)` map using the project's format config (quoting style, var naming, ordering).
7. Daemon responds with the bytes. Records a read event for logs/metrics.

### Write flow (developer edits `.env` in their editor)

1. Editor saves. macOS issues a WebDAV `PUT` to the daemon.
2. Daemon parses the incoming `.env` bytes into a key→value map.
3. Daemon diffs against `(provider-snapshot merged with previous staging)`:
   - Additions, modifications, deletions all captured as **staged changes**.
4. Staged changes are persisted in SQLite (per-project). **No push to the provider happens here.**
5. Next read returns the merged view, so the developer sees their edit immediately.
6. `d-env diff` prints the staged delta against the remote.
7. `d-env commit` pushes staged changes to the provider, clears the staging, and refreshes the cache.

This keeps "edit in your editor" and "publish to the team" as two distinct steps — the same model as git.

### Conflict / drift handling

- Before `commit`, daemon does a fresh provider fetch. If a value the developer staged has also changed upstream, `commit` aborts with a clear diff and options: `--theirs`, `--ours`, or re-stage.
- `pull` drops staging and re-reads from the provider. Destructive; requires `--force` if staging is non-empty.

## Process & security model

- Both HTTP servers bind **only** to `127.0.0.1`. No network exposure.
- The WebDAV endpoint requires a token in the URL path (per-project), validated constant-time. Loopback is still the primary boundary.
- The control API requires a token set in a local file readable only by the current user (`~/.d-env/control.token`). CLI reads this file to authenticate.
- Provider credentials in **OS keychain** first:
  - macOS: `security`/Keychain via `keytar` or direct `security` CLI.
  - Linux: `libsecret` via `keytar`, falls back to age/scrypt-encrypted file with a user-prompted passphrase.
- Secret values in memory: zeroized after use where feasible in JS (JS makes this imperfect; document the limitation rather than pretend).
- Logs: never log values. Only keys, lengths, counts, timing. Log levels configurable.

## Port / path conventions

| Thing               | Default               | Override                          |
| ------------------- | --------------------- | --------------------------------- |
| WebDAV port         | `1911`                | `d-env config set daemon.webdav.port` |
| Control API port    | `1910`                | `d-env config set daemon.control.port` |
| State dir           | `~/.d-env/`           | `$D_ENV_HOME`                     |
| Mount point (macOS) | `~/.d-env/mount`      | `d-env config set mount.macos.path` |
| Mount point (Linux) | `~/.d-env/mount`      | `d-env config set mount.linux.path` |
| WebDAV path schema  | `/p/<project-id>.<tok>/.env` | fixed in v1                       |

## Why WebDAV (vs. the alternatives we rejected)

| Option                | Verdict for v1 | Why                                                             |
| --------------------- | -------------- | --------------------------------------------------------------- |
| Plain symlink only    | No             | No event hook on read; can't generate dynamically.              |
| `inotify` / `FSEvents` | No            | Notifies *after* access; can't block the open to fetch fresh.   |
| FUSE (`macFUSE`, `fuse3`) | No        | Requires kernel extension / third-party install; cross-platform headache. |
| NFS                   | No             | Heavyweight setup, needs root, bad DX.                          |
| **WebDAV (loopback HTTP)** | **Yes**   | Native mount on macOS and Linux, user-space server, blocks on read correctly, bidirectional. |

Windows has a WebDAV Redirector with some quirks (HTTPS preferences, timeouts, size limits). Worth a dedicated design pass when we add Windows; not v1.

## Libraries (proposed, not final)

- WebDAV server: start by evaluating `webdav-server` (v2). If constraints bite (e.g. streaming, virtual FS hooks), drop to implementing the subset of WebDAV verbs we actually need (`OPTIONS`, `PROPFIND`, `GET`, `PUT`, `LOCK`/`UNLOCK`, `DELETE`) on top of `node:http`.
- Control API server: `fastify` or plain `node:http` + a small router. Nothing heavy.
- CLI: `commander` or `@commander-js/extra-typings`.
- State store: `better-sqlite3` (sync, simple, fast — fine for a daemon).
- Keychain: `keytar` where available; hand-rolled fallback otherwise.
- Testing: `vitest`.

Final library choices are decided in the implementation plan, not here.
