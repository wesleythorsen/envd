# CLI spec — `d-env`

The CLI is a thin client. Every command that mutates state calls the daemon's control API. If the daemon isn't running, commands that need it auto-start it (unless `--no-autostart` is passed).

## Global flags

- `--json` — machine-readable output. All commands must support this.
- `--quiet` / `-q` — suppress non-error stdout.
- `--verbose` / `-v` — extra logging to stderr.
- `--daemon-url <url>` — override control-API URL (defaults to the one in `~/.d-env/`).

## Commands (v1)

### `d-env init [path]`

Initialize a project in the current (or given) directory.

- Prompts interactively for:
  - Provider (default: `local-file`; other options once their plugins are added).
  - Provider-specific config (e.g. Doppler project + config).
  - Mapping strategy — which keys from the provider become which vars in `.env`.
- Starts the daemon and mount if missing.
- Registers the project with the daemon, gets back a `project-id` and token.
- Creates `./.env -> <mount>/p/<id>.<tok>/.env` symlink.
- Writes a `.d-env.json` (or adds a `d-env` key to `package.json`) at the project root recording project-id, provider name, and format options. Values are **not** stored here.
- Adds `.env` to `.gitignore` if missing (safe default).
- Idempotent: re-running in an already-initialized project is a no-op with a short summary.

### `d-env link [path]`

Re-create the symlink for an already-registered project (e.g. after a fresh clone where `.d-env.json` exists but the symlink doesn't). Does not re-prompt for provider config.

### `d-env unlink [path]`

Remove the project's symlink. Optionally `--purge` to also remove the project from the daemon's registry and drop staging.

### `d-env status`

Print the current project's state:
- Project id, provider, format.
- Last successful provider fetch (timestamp).
- Staged changes summary (count of adds/mods/dels).
- Daemon health (running? version? ports?).

### `d-env diff`

Show staged vs. remote diff in a `git diff`-like format, with keys only by default. `--values` reveals secret values inline. `--json` for structured output.

### `d-env commit [-m <message>]`

Push staged changes to the provider.
- Re-fetches provider state first to detect upstream drift.
- Aborts with a clear diff on conflict; offers `--theirs` / `--ours` / `--interactive`.
- On success: clears staging, refreshes cache, prints summary.

### `d-env pull`

Drop local staging and refresh the provider snapshot.
- With non-empty staging, requires `--force`.
- `--dry-run` shows what would change.

### `d-env provider <subcommand>`

- `d-env provider list` — providers registered with the daemon and their configured instances.
- `d-env provider add <name>` — add a provider instance (prompts for creds, stores in keychain).
- `d-env provider remove <id>` — remove an instance; refuses if any project uses it.
- `d-env provider test <id>` — hit the provider to confirm credentials work.

### `d-env daemon <subcommand>`

- `d-env daemon status` — PID, uptime, ports, loaded projects.
- `d-env daemon start` — start if not running.
- `d-env daemon stop` — graceful shutdown.
- `d-env daemon restart` — stop + start.
- `d-env daemon logs [--tail -f]` — stream logs.
- `d-env daemon install` — install as launchd / systemd-user unit so it starts on login.
- `d-env daemon uninstall` — remove the unit.

### `d-env mount <subcommand>`

- `d-env mount status` — is the WebDAV volume mounted where we expect?
- `d-env mount remount` — unmount + mount.
- `d-env mount unmount` — unmount.

### `d-env config <get|set|list> [key] [value]`

Read/write user-level config in `~/.d-env/config.json`. Ports, mount paths, defaults.

### `d-env version`

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
- **No implicit commits.** Edits are always staged; nothing is pushed without `d-env commit`.
- **Safe by default.** Destructive commands (`pull` with staging, `unlink --purge`, `provider remove`) always require a confirmation or `--force`.
- **Discoverable.** `d-env help <cmd>` prints command-specific docs pulled from the same source used to build the online docs.
