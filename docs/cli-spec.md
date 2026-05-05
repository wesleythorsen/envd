# CLI spec — `envd`

The CLI is a thin client. Every command that mutates state calls the daemon's control API. If the daemon isn't running, commands that need it auto-start it (unless `--no-autostart` is passed).

## Global flags

- `--json` — machine-readable output. All commands must support this.
- `--quiet` / `-q` — suppress non-error stdout.
- `--verbose` / `-v` — extra logging to stderr.
- `--daemon-url <url>` — override control-API URL (defaults to the one in `~/.envd/`).

## Commands (v1)

### `envd init [path]`

Initialize a project in the current (or given) directory.

- Prompts interactively for:
  - Provider (default: `local-file`; other options once their plugins are added).
  - Provider-specific config (e.g. Doppler project + config).
  - Mapping strategy — which keys from the provider become which vars in `.env`.
- Starts the daemon and mount if missing.
- Registers the project with the daemon, gets back a `project-id` and token.
- Creates `./.env -> <mount>/p/<id>.<tok>/.env` symlink.
- Writes a `.envd.json` (or adds a `envd` key to `package.json`) at the project root recording project-id, provider name, and format options. Values are **not** stored here.
- Adds `.env` to `.gitignore` if missing (safe default).
- Idempotent: re-running in an already-initialized project is a no-op with a short summary.

### `envd link [path]`

Re-create the symlink for an already-registered project (e.g. after a fresh clone where `.envd.json` exists but the symlink doesn't). Does not re-prompt for provider config.

### `envd unlink [path]`

Remove the project's symlink. Optionally `--purge` to also remove the project from the daemon's registry and drop staging.

### `envd status`

Print the current project's state:
- Project id, provider, format.
- Last successful provider fetch (timestamp).
- Staged changes summary (count of adds/mods/dels).
- Daemon health (running? version? ports?).

### `envd diff`

Show staged vs. remote diff in a `git diff`-like format, with keys only by default. `--values` reveals secret values inline. `--json` for structured output.

### `envd commit [-m <message>]`

Push staged changes to the provider.
- Re-fetches provider state first to detect upstream drift.
- Aborts with a clear diff on conflict; offers `--theirs` / `--ours` / `--interactive`.
- On success: clears staging, refreshes cache, prints summary.

### `envd pull`

Drop local staging and refresh the provider snapshot.
- With non-empty staging, requires `--force`.
- `--dry-run` shows what would change.

### `envd provider <subcommand>`

- `envd provider list` — providers registered with the daemon and their configured instances.
- `envd provider add <name>` — add a provider instance (prompts for creds, stores in keychain).
- `envd provider remove <id>` — remove an instance; refuses if any project uses it.
- `envd provider test <id>` — hit the provider to confirm credentials work.

### `envd daemon <subcommand>`

- `envd daemon status` — PID, uptime, ports, loaded projects.
- `envd daemon start` — start if not running.
- `envd daemon stop` — graceful shutdown.
- `envd daemon restart` — stop + start.
- `envd daemon logs [--tail -f]` — stream logs.
- `envd daemon install` — install as launchd / systemd-user unit so it starts on login.
- `envd daemon uninstall` — remove the unit.

### `envd mount <subcommand>`

- `envd mount status` — is the WebDAV volume mounted where we expect?
- `envd mount remount` — unmount + mount.
- `envd mount unmount` — unmount.

### `envd config <get|set|list> [key] [value]`

Read/write user-level config in `~/.envd/config.json`. Ports, mount paths, defaults.

### `envd version`

Print CLI version, daemon version (if reachable), protocol version.

## Exit codes

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| `0`  | Success.                                    |
| `1`  | Generic error.                              |
| `2`  | Usage error (bad flags/args).               |
| `3`  | Daemon unreachable and autostart disabled.  |
| `4`  | Provider error (network, auth, quota).      |
| `5`  | Conflict on commit (upstream drift).        |
| `6`  | Mount operation failed.                     |
| `7`  | Not initialized / project not registered.   |

## Output conventions

- Human output: one short summary line + optional detail table. Color via `chalk` only on TTY.
- JSON output: single object per command. Schema documented alongside each command.
- Errors: human-readable message on stderr + structured `{ "error": { "code": "...", "message": "...", "details": {...} } }` when `--json`.

## UX principles

- **Never silently swallow a provider error on read.** If the `.env` can't be rendered, the WebDAV `GET` returns 503 with a header; the CLI surfaces that clearly when asked for status.
- **No implicit commits.** Edits are always staged; nothing is pushed without `envd commit`.
- **Safe by default.** Destructive commands (`pull` with staging, `unlink --purge`, `provider remove`) always require a confirmation or `--force`.
- **Discoverable.** `envd help <cmd>` prints command-specific docs pulled from the same source used to build the online docs.
