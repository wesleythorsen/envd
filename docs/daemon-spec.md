# Daemon spec — `envdd`

## Responsibilities

1. Serve the WebDAV endpoint the OS mounts.
2. Serve the control HTTP API the CLI talks to.
3. Own all state: project registry, staged changes, provider configs, caches.
4. Talk to providers. The CLI never does.

## Lifecycle

- Start: CLI commands auto-launch the daemon if it isn't running (unless `--no-autostart`).
- PID and port info written to `~/.envd/envdd.pid` and `~/.envd/envdd.ports` on startup.
- On startup: open SQLite, load project registry into memory, bind sockets, start HTTP servers, warm cache lazily (nothing fetched until first read).
- Shutdown: SIGTERM triggers graceful shutdown — drain in-flight requests, flush SQLite, remove PID/port files.
- Single-instance: startup aborts if PID file points to a live process.

## WebDAV server

- Default bind: `127.0.0.1:1911`.
- Serves a single virtual root with one subtree per project: `/p/<project-id>.<token>/…`.
- Supported verbs (v1 minimum):
  - `OPTIONS` — advertise WebDAV capabilities (class 1, plus `LOCK`/`UNLOCK` if the mount client requires class 2).
  - `PROPFIND` — list the virtual directory contents and stat files. Depth 0 and 1.
  - `GET` — read a rendered file (e.g. `.env`).
  - `PUT` — write a file; parsed and staged.
  - `DELETE` — on a data file, interpreted as "stage deletion of all its keys." Rare; mostly for tool compatibility.
  - `LOCK` / `UNLOCK` — advisory locks for editors that require them (TextEdit/BBEdit occasionally do on macOS). No-op semantics are fine if they satisfy clients.
  - `PROPPATCH` — accept no-op metadata writes (some clients set timestamps).
- Error model: return WebDAV-compatible XML on failure, with a custom `X-Envd-Error: <code>` header for easier CLI diagnosis.

### Virtual layout

```
/
└── p/
    └── <project-id>.<token>/
        └── .env            ← rendered on demand for v1
        (future) config.yaml, flags.json, …
```

### Read semantics

- On `GET /p/<id>.<tok>/.env`:
  1. Validate token against registry (constant-time compare). On mismatch → `404` (not `403`, to avoid enumeration).
  2. Load provider snapshot. Use cache if TTL not expired; else fetch.
  3. Merge with any staged changes for this project.
  4. Render to `.env` bytes.
  5. Return with headers:
     - `Content-Type: text/plain; charset=utf-8`
     - `ETag: "<hash of merged map + format>"`
     - `Last-Modified: <max(provider-fetch-time, last-stage-time)>`
  6. Support `If-None-Match` → `304 Not Modified` to reduce re-fetch churn when editors poll.

### Write semantics

- On `PUT /p/<id>.<tok>/.env`:
  1. Validate token.
  2. Parse body as `.env` (using the same parser we render with).
  3. Compute diff vs. `(provider-snapshot ⊕ previous-staging)`.
  4. Persist new staging (atomic replace for that project; fully overwrites previous staging — the PUT represents the new desired state).
  5. Record a `staged` event. Return `204 No Content`.
- On parse error: `400` with an `X-Envd-Error: bad-dotenv` header and a short body. Do not update staging.

### Locking

- Accept `LOCK` and return a synthetic lock token. Respect `UNLOCK`. We don't actually serialize writes beyond a short per-project mutex — WebDAV locking is mainly theater for editor compatibility.

## Control API

- Default bind: `127.0.0.1:1910`.
- All requests require header `Authorization: Bearer <token>` matching `~/.envd/control.token`.
- All responses JSON. All requests JSON when they have bodies.
- Versioned: base path `/v1/…`.

### Endpoints (v1)

#### Health / meta

- `GET /v1/health` → `{ ok: true, version, uptimeSec }`
- `GET /v1/version` → `{ cli, daemon, protocol }`

#### Projects

- `GET /v1/projects` — list.
- `POST /v1/projects` — register new. Body: `{ path, providerInstanceId, providerConfig, format }`. Returns `{ id, token, mountPath }`.
- `GET /v1/projects/:id` — detail + staging summary.
- `DELETE /v1/projects/:id` — deregister. Query `purge=true` to also delete staging.
- `POST /v1/projects/:id/symlink` — (re)create the symlink on disk. Convenience for `envd link`.

#### Staging / sync

- `GET /v1/projects/:id/diff` — structured diff between staging and remote snapshot.
- `POST /v1/projects/:id/commit` — push staging to provider. Body: `{ message?, strategy: "abort" | "theirs" | "ours" }`. Default `abort` on conflict.
- `POST /v1/projects/:id/pull` — refresh from provider. Body: `{ force?: boolean }` when staging is non-empty.

#### Providers

- `GET /v1/providers` — registered plugin names + per-plugin schema for creating instances.
- `GET /v1/provider-instances` — configured instances (id, name, provider name, non-secret config only).
- `POST /v1/provider-instances` — create. Body includes secrets only transiently; daemon immediately moves them to the keychain.
- `DELETE /v1/provider-instances/:id` — remove. Refuses with a clear error if any project references it.
- `POST /v1/provider-instances/:id/test` — round-trip a harmless API call.

#### Daemon control

- `POST /v1/shutdown` — graceful stop.
- `GET /v1/logs?tail=N` — last N log lines. `?follow=true` upgrades to SSE.

### Error shape

```json
{ "error": { "code": "provider_unreachable", "message": "…", "details": { } } }
```

Stable `code` values are the CLI contract — documented alongside exit codes.

## State store schema (SQLite)

```
projects(
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  path TEXT NOT NULL,                -- absolute path of the project on disk
  provider_instance_id TEXT NOT NULL REFERENCES provider_instances(id),
  format TEXT NOT NULL,              -- e.g. "dotenv" in v1
  format_config TEXT NOT NULL,       -- JSON: quoting style, key mapping, ordering
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)

provider_instances(
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,            -- "doppler" | "local-file" | …
  name TEXT NOT NULL,                -- user-given label
  config TEXT NOT NULL,              -- JSON, non-secret config only
  created_at INTEGER NOT NULL
)

snapshots(
  project_id TEXT NOT NULL REFERENCES projects(id),
  fetched_at INTEGER NOT NULL,
  data TEXT NOT NULL,                -- JSON map {key: value}, encrypted at rest
  etag TEXT
)

staging(
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  updated_at INTEGER NOT NULL,
  desired TEXT NOT NULL              -- JSON map {key: value|null}, encrypted at rest
)

events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- read, write, commit, pull, error
  project_id TEXT,
  details TEXT                       -- JSON, never contains values
)
```

Encryption at rest: per-daemon symmetric key stored in the OS keychain; `snapshots.data` and `staging.desired` are sealed with it.

## Cache

- Per-project in-memory LRU of the latest snapshot + its fetch time.
- TTL configurable per provider instance (default 60s).
- `GET /v1/projects/:id/pull` forces refresh; WebDAV `GET` triggers a refresh only if the snapshot is expired.
- Refresh is coalesced: concurrent reads during a pending fetch await the same promise.

## Logging & metrics (v1)

- Structured JSON logs to `~/.envd/logs/envdd.log` (rotated at 5 MB, 5 files).
- No values in logs; only keys, counts, timings, provider names.
- Emit a minimal set of counters on request (`GET /v1/health?metrics=true`): reads, writes, commits, provider errors, cache hit ratio. Keeps us honest about performance without an external dependency.
