# CLI spec — `envd`

The CLI is a thin client. Every command that mutates state calls the daemon's control API. If the daemon isn't running, commands that need it auto-start it (unless `--no-autostart` is passed).

## Global flags

- `--json` — machine-readable output. All commands must support this.
- `--quiet` / `-q` — suppress non-error stdout.
- `--verbose` / `-v` — extra logging to stderr.
- `--daemon-url <url>` — override control-API URL (defaults to the discovered daemon port file in envd runtime/state storage).

## Commands (redesigned UX)

### `envd init [path]`

Initialize a project in the current (or given) directory.

- Starts the daemon and mount if missing, unless `--no-autostart` is passed.
- Scans common env-file locations: project root, `config/`, `configs/`, `env/`, `envs/`, `environments/`, `.config/`, and root-level framework env files such as `.env.*`.
- Infers environment names from files such as `.env`, `.env.local`, `.env.dev`, `.dev.env`, and `dev.env`.
- Shows an adoption plan with files, inferred environments, key counts, duplicate warnings, target provider instance/org, project name, active environment, and source-file disposition.
- If no provider instance exists, creates or reuses a local envd-managed provider instance named `personal`.
- Supports existing provider users with `--provider <name>` or inline setup via `--new-provider`.
- Registers the project with the daemon, gets back a `project-id` and token.
- Writes project registration to the user-level envd TOML config. It does **not** write `.envd.json` to the repository.
- Creates `./.env -> <mount>/p/<id>.<tok>/.env` symlink.
- Adds `.env` to `.gitignore` if missing (safe default).
- Moves imported source env files to `.envd-retired/<timestamp>/` with a receipt by default. `--delete-imported-files` deletes only after verified import.
- Idempotent: re-running in an already-initialized project is a no-op with a short summary.

Flags:

- `--yes` — accept the proposed adoption plan.
- `--provider <name>` — use an existing provider instance/org.
- `--new-provider` — run provider setup during init.
- `--provider-type <type>` — provider type for non-interactive `--new-provider`.
- `--provider-name <name>` — provider instance/org name for non-interactive `--new-provider`.
- `--env-file <env>=<path>` — explicit env-file mapping; repeatable.
- `--active <env>` — initial active environment.
- `--scan <path>` — add an explicit scan location; repeatable.
- `--delete-imported-files` — delete source files after verified import instead of retiring them.
- `--retired-dir <path>` — override the retired-files directory.

### `envd link [path]`

Re-create the symlink for an already-registered local project. Looks up the project by canonical project root in the envd TOML config. Does not re-prompt for provider config.

### `envd unlink [path]`

Remove the project's symlink. Optionally `--purge` to also remove the project from the daemon's registry and drop staging.

### `envd use [environment]`

Switch the active project environment.

- With no argument, opens an interactive environment selector.
- With an argument, switches directly.
- Updates both project active-environment state and the managed `.env` view.
- Preserves uncommitted changes for other environments.
- Refuses unknown environments unless `--create` is provided.

### `envd run [environment] -- <command...>`

Run a child process with secrets from the named environment. With no environment argument, uses the active environment.

- Fetches/renders the selected environment before spawning.
- Injects variables into the child process environment.
- Does not switch the project-global active environment.
- Propagates the child exit code.
- Does not log secret values.

### `envd status`

Print the current project's workflow state:

- Active environment.
- Provider instance/org and provider health.
- Local uncommitted changes by environment.
- Upstream changes or stale snapshot warnings.
- Whether `.env` is linked and current.
- Next suggested action.

Daemon and mount details are collapsed unless unhealthy. Use `envd status --full` or `envd daemon status` for process diagnostics.

### `envd diff [environment]`

Show staged vs. remote diff in a `git diff`-like format, with keys only by default. `--values` reveals secret values inline. `--json` for structured output.

### `envd commit [environment] [-m <message>]`

Push staged changes to the provider.
- Re-fetches provider state first to detect upstream drift.
- Aborts with a clear diff on conflict; offers `--theirs` / `--ours` / `--interactive`.
- On success: clears staging, refreshes cache, prints summary.

### `envd pull [environment]`

Drop local staging and refresh the provider snapshot.
- With non-empty staging, requires `--force`.
- `--dry-run` shows what would change.

### `envd eject`

Return a project to ordinary env files.

- Shows which env files will be recreated.
- Recreates files from current committed provider values by default.
- `--from-retired` restores exact pre-adoption files when a retired-file receipt exists.
- Removes the managed `.env` symlink.
- Removes the current project registration from envd TOML config after confirmation.
- `--purge` also removes local daemon/state records for the project.

### `envd provider <subcommand>`

- `envd provider list` — providers registered with the daemon and their configured instances.
- `envd provider add <type> --name <name>` — add a named provider instance/org (prompts for creds, stores in keychain).
- `envd provider remove <id>` — remove an instance; refuses if any project uses it.
- `envd provider test <id>` — hit the provider to confirm credentials work.

### `envd project <subcommand>`

- `envd project move --provider <name>` — copy the current project's environments/configs to another provider instance/org, verify target reads, then update the project binding.
- `envd project relink` — repair the registered root path after moving a directory.

### `envd browse`

Read-only CLI/TUI browser for projects, environments, and keys. Values require explicit reveal. Non-TTY mode prints a table or JSON.

### `envd doctor`

Diagnose daemon, control token, mount, project registration, `.env` symlink, provider health, migrations, and stale runtime files. `--fix` attempts safe repairs; destructive repairs require confirmation or `--force`.

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

### `envd config <get|set|list|edit> [key] [value]`

Read/write user-level config in `$XDG_CONFIG_HOME/envd/config.toml` or `~/.config/envd/config.toml`. `envd config edit` opens the TOML file in `$VISUAL` or `$EDITOR`, validates it, and preserves the previous config if validation fails.

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
