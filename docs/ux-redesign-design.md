# envd UX Redesign Design Draft

Status: approved for implementation.

## Problem

The current product exposes too much of its implementation model. A new user must understand that `envd` depends on a daemon, a WebDAV server, a mounted directory, provider instances, and a symlink before they can form a simple mental model of what the tool does.

The redesigned UX should make the user model:

1. Import existing env files.
2. Pick an environment.
3. Edit `.env` normally.
4. Review local changes.
5. Save those changes back to the secret store.
6. Run project commands with a chosen environment.

Daemon, WebDAV, mount, control API, and service installation remain available for diagnosis and advanced operations, but they should not be part of the happy path.

## Design Principles

- Background processes are implementation details. User-facing commands should auto-start and auto-repair the daemon/mount when possible.
- The first run should be an adoption flow, not a provider configuration lesson.
- `status` should answer "what is my secrets working tree state?" before it answers "is the daemon running?"
- Existing env files are valuable source data. The tool must not lose them silently.
- The core workflow should feel close to Git: local edits, visible diff, explicit commit, explicit pull/discard.
- Every interactive flow must have a non-interactive equivalent for CI and scripting.
- Advanced commands stay available under explicit namespaces such as `envd daemon`, `envd provider`, and possibly `envd doctor`.

## Proposed User Model

### Project

A project is a repository or application root managed by `envd`.

The project has:

- one project registration in the user's envd TOML config;
- one currently selected environment;
- one managed `.env` symlink or generated working file;
- zero or more named environments such as `local`, `dev`, `stage`, `prod`;
- one backing provider instance/org.

The project should not have a repo-local `.envd.json` file. Project bindings are machine-local state, similar to Doppler's local config model, and should live in the user's envd config directory instead of in the repository.

### Environment

An environment is a named key/value set inside a project. Existing files map to environments during adoption.

Examples:

- `.env` -> `local`
- `.env.local` -> `local`
- `.env.dev` -> `dev`
- `.dev.env` -> `dev`
- `dev.env` -> `dev`
- `.env.stage` -> `stage`
- `.env.production` -> `production`

When detection is ambiguous, `envd init` should show the proposed mapping and ask for confirmation or correction.

### Provider

Providers are storage backends. New users should not have to learn the provider model before the first successful import, but existing Doppler, Bitwarden, AWS, or other provider users need a quick path to bring their preferred provider into the workflow.

The provider model should have four levels:

- provider type: the backend driver, such as `local-file`, `doppler`, `bitwarden`, or `aws`;
- provider instance/org: a named configured backend workspace or account, such as `personal`, `take2`, or `my-work`;
- project/service: a deployed service or repository inside that provider instance;
- environment/config: a named config inside a project, equivalent to Doppler configs selected with `-c`.

In user-facing CLI language, `--provider <name>` should select a named provider instance. That provider instance is also the org-like boundary: it represents where a set of projects' secrets live and maps naturally to a personal workspace, work organization, client, or team.

Examples:

- `personal`
- `take2`
- `acme`
- `oss`

The default provider instance/org name is `personal`.

The current `local-file` provider is conceptually too low level for this user model: one configured storage target reads and writes one JSON object file. It is useful for tests and explicit advanced setups, but it is not a good first-run default for users migrating `.env` files because it asks them to pick a JSON storage file before they understand the provider model.

For the first-run local path, `envd` should create or reuse an envd-managed local provider instance named `personal`. This keeps `envd init` seamless while still making the eventual move to Doppler, Bitwarden, AWS, or another provider a normal provider-instance change rather than a special migration.

`envd init --provider take2` should initialize the current project under the existing `take2` provider instance. `envd init --new-provider` should run a provider setup workflow during init, with optional flags such as `--provider-type doppler` and `--provider-name take2` for non-interactive use.

`envd provider add doppler --name take2` should set up a named Doppler provider instance after init. Once configured, a project can be moved to it with a project-level provider migration command such as `envd project move --provider take2`. That command should copy the current project's environments/configs to the target provider instance, verify reads, then update the project binding. It should leave the old source provider data intact unless the user explicitly purges it.

Within a provider instance/org, each repository still imports into its own envd project by default. Secrets are not shared across projects unless the user explicitly creates a future shared-secret/link relationship.

Example flow:

1. A user runs `envd init` in a personal repository. `envd` imports root env files into the default `personal` org under a project named after the repo.
2. The same user later runs `envd provider add doppler --name my-work` and completes Doppler setup for their work org/account.
3. In a work repository, they run `envd init --provider my-work`. `envd` imports env files from common locations such as `env/` into a separate project inside the `my-work` provider instance.
4. The user can initialize multiple work repositories under `my-work`; each repo remains a separate project with separate environments/configs.
5. A later hosted or browser-backed surface may allow explicit secret linking or promotion into a shared base store, but that is not part of the initial CLI redesign.

Future hosted envd provider work can build on this same UX, but a hosted SaaS should be treated as a separate product decision. The local-only dashboard can be implemented first without network accounts, billing, or team semantics.

## Command Model

### `envd init [path]`

Primary onboarding command.

Expected behavior:

1. Auto-start daemon and mount if needed.
2. Scan common env-file locations.
3. Ignore obvious dependency/build directories such as `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.turbo`, and `.worktrees` if any configured scan location includes them.
4. Infer environments from filenames.
5. Show an adoption plan:
   - files found;
   - inferred environment names;
   - key counts;
   - duplicate key warnings;
   - destination provider instance/org, provider type, project, and backing provider;
   - what will happen to the original files.
6. If this is the user's first provider instance/org, create a local envd-managed `personal` instance automatically.
7. If the user already has provider instances, suggest the default and allow choosing another.
8. Import parsed values into the selected provider.
9. Write or update the per-user project registration in the envd TOML config.
10. Link or materialize the active `.env`.
11. Move imported source env files to a retired-files location after confirmation.
12. Print the next commands: `envd use`, `envd status`, and `envd eject`.

Destructive behavior:

The idea dump proposes deleting imported env files. The safer default should be retiring them without leaving ambiguity about whether they are active. Imported files should be moved to an ignored directory such as `.envd-retired/<timestamp>/` with a migration receipt. The command output should avoid soft language like "backup" as the primary label and instead say that these files have been retired and are no longer used by the project.

The receipt should include:

- original path;
- retired path;
- inferred environment;
- imported key count;
- import timestamp;
- provider instance/org destination;
- command to undo the adoption.

An explicit `--delete-imported-files` flag can remove source files after import verification, but this should be an advanced option. The default should be reversible.

Undo behavior:

`envd eject` should be the project-level undo command. It should recreate ordinary env files from the current provider values or from the retired-file receipt, remove the managed `.env` symlink, and optionally deregister the project from envd. This is clearer than `envd uninstall`, which sounds global and could be confused with uninstalling the CLI.

Non-interactive flags:

- `--yes`
- `--provider <name>`
- `--new-provider`
- `--provider-type <type>`
- `--provider-name <name>`
- `--env-file <env>=<path>` repeatable
- `--active <env>`
- `--delete-imported-files`
- `--retired-dir <path>`
- `--json`

`--provider <name>` selects an existing provider instance/org, not a provider type. `--new-provider` starts provider setup inline during init. In interactive mode, `envd init --new-provider` can prompt for type and name; in non-interactive mode, it should require enough flags to avoid guessing.

Default scan scope:

`envd init` should not scan the whole tree by default. It should scan common env locations:

- project root;
- `config/`;
- `configs/`;
- `env/`;
- `envs/`;
- `environments/`;
- `.config/`;
- framework-specific root env files such as `.env.*`.

The user can expand the scan with `--scan <path>` repeatable, or bypass scanning with explicit `--env-file <env>=<path>` mappings.

### `envd use [environment]`

Select the active environment for the project.

Expected behavior:

- With no argument, open an interactive selector.
- With an argument, switch directly.
- Preserve uncommitted changes for the previous environment.
- Refuse to switch if the target environment is unknown unless `--create` is provided.
- Ensure daemon/mount health before relinking or refreshing `.env`.
- Print a concise summary of active environment and local change state.

Decision:

`envd use <env>` updates both project active-environment state and the managed `.env` view. The current architecture has one rendered `.env` per project, so the redesign should extend project state and staging to include `environment`. Reads and writes are scoped to the active environment.

### `envd run <environment> -- <command...>`

Run a command with a chosen environment.

Expected behavior:

- Fetch/render the requested environment.
- Inject variables into the child process environment.
- Avoid requiring the user to switch the project-global active environment.
- Optionally support `envd run -- <command...>` using the active environment.
- Surface provider errors before spawning the child process.

This command is valuable even for projects that do not want a live `.env` symlink.

Decision:

The MVP injects process environment variables only. A later explicit flag can add temporary dotenv-file support for tools that require a file path, but the default should avoid writing extra secret material to disk.

### `envd status`

Default status should be project/workflow centered.

Show:

- active environment;
- provider and provider health;
- local uncommitted changes by environment;
- upstream changes or stale snapshot warnings;
- whether `.env` is linked and current;
- next suggested action.

Daemon and mount details should be summarized only when relevant. Full process diagnostics move to:

- `envd status --full`, or
- `envd doctor`, or
- `envd daemon status`.

### `envd diff [environment]`

Show staged changes for the active or named environment. Keep values hidden unless `--values` is passed.

### `envd commit [environment]`

Push staged changes for the active or named environment. Conflict behavior remains explicit.

### `envd pull [environment]`

Refresh the active or named environment. Preserve the current safety behavior: refuse to discard local staging unless forced.

### `envd eject`

Return a project to ordinary env files.

Expected behavior:

- Show which env files will be recreated.
- Prefer current provider values so eject reflects the latest committed state.
- Offer `--from-retired` to restore exactly what was imported during adoption when a receipt exists.
- Remove the managed `.env` symlink.
- Remove the current project registration from the user's envd TOML config when the user confirms.
- Optionally purge the project from local envd state with `--purge`.
- Leave provider instance/org state intact unless explicitly purged.

This command is the user's safety net for trying envd without feeling trapped.

### `envd provider add <type> --name <name>`

Configure a named provider instance/org.

Expected behavior:

- prompt for provider-specific settings and credentials;
- test connectivity before saving;
- store the instance under the provided name;
- refuse duplicate names unless `--replace` is explicit;
- print the next command, such as `envd init --provider <name>` or `envd project move --provider <name>`.

Examples:

```sh
envd provider add doppler --name take2
envd provider add bitwarden --name personal-vault
```

### `envd project move --provider <name>`

Move the current project from one provider instance/org to another.

Expected behavior:

- copy every environment/config for the current project to the target provider instance;
- preserve project and environment names unless the user explicitly remaps them;
- verify target reads before updating the project registration or state bindings;
- leave source provider data intact by default;
- support an explicit purge flag for users who want to remove the old copy after verification.

### `envd open`

Open a local browser UI for the current project.

MVP behavior:

- daemon serves a local-only UI on loopback;
- browser opens to the project and active environment;
- UI can browse environments and keys;
- values are hidden by default;
- editing can be read-only in the first story and become writable later.

This is not a hosted service in the redesign MVP. It is a local product surface that can later point to a hosted provider if that product decision is made.

Decision: defer `envd open` to a later wave. The initial redesign should focus on the CLI workflow.

### `envd browse`

Open a CLI/TUI browser for projects, environments, and keys.

MVP behavior:

- list environments;
- show key counts and changed status;
- reveal values only by explicit action or flag;
- no daemon/process vocabulary in the default view.

### `envd doctor`

Diagnose and repair support infrastructure.

Checks:

- daemon process;
- control API auth;
- WebDAV mount;
- project registration;
- `.env` symlink;
- provider health;
- state DB migrations;
- stale pid/ports files.

Repair mode:

- `envd doctor --fix` attempts safe repairs;
- destructive repairs require confirmation or `--force`.

## Daemon Autostart And Health

All normal commands that need the daemon should use a shared preflight:

1. Try control API health.
2. If unreachable, start daemon.
3. Wait for health.
4. Check mount if the command needs `.env` file access.
5. Mount if missing.
6. Return a typed health result to the command.

Commands should not tell users to run `envd daemon start` unless autostart fails or `--no-autostart` is set.

## Local Config And State Layout

The redesign should stop writing project metadata into repositories. Instead, envd should keep one user-editable TOML config file for durable local configuration and separate non-config state/runtime data into purpose-specific directories.

Recommended default paths:

- config: `$XDG_CONFIG_HOME/envd/config.toml`, falling back to `~/.config/envd/config.toml`;
- state: `$XDG_STATE_HOME/envd/`, falling back to `~/.local/state/envd/`;
- cache: `$XDG_CACHE_HOME/envd/`, falling back to `~/.cache/envd/`;
- runtime: `$XDG_RUNTIME_DIR/envd/` when available, with a safe fallback under the state directory;
- mount: runtime dir by default, configurable with `ENVD_MOUNT_PATH` or `envd config set mount.path`.

`~/.envd/` exists in the current implementation because it is a simple single home for config, SQLite state, daemon files, logs, and the WebDAV mount. That is understandable for an MVP, but it is not the right long-term user-facing layout because `~/.config` should not contain mutable databases, logs, runtime tokens, or mount directories. The redesign should introduce XDG-style separation while keeping `ENVD_HOME` as a coarse override for tests and portable/dev use.

The TOML config should contain non-secret, user-editable configuration only:

```toml
version = 1
default_provider = "personal"

[providers.personal]
type = "local"

[providers.my-work]
type = "doppler"

[[projects]]
id = "proj_..."
name = "my-app"
root = "/Users/wes/repos/my-app"
provider = "personal"
provider_project = "my-app"
active_environment = "dev"
env_file = ".env"
```

Secrets and high-churn data should not live in `config.toml`:

- provider credentials live in the OS keychain or encrypted fallback storage;
- local provider secret values live in encrypted data/state storage;
- staged changes, cached snapshots, and migrations live in SQLite state;
- daemon pid, ports, and control token live in runtime/state locations with restrictive permissions;
- logs live in the state directory.

Because this file is TOML and intended to be user-editable, `envd config edit` should open it in `$VISUAL` or `$EDITOR` and validate the schema before accepting changes. Invalid edits should leave the previous config intact and show the validation error.

Project discovery should work without a repo-local file:

1. Resolve the project root from the command path, preferring the nearest Git root when present.
2. Canonicalize the root path.
3. Look up that path in `config.toml`.
4. If no registration exists, report "not initialized" and suggest `envd init`.
5. If the directory moved, provide a repair flow such as `envd project relink` or an `envd init` prompt that updates the registered root after confirmation.

## State Model Changes

The redesign likely needs these model additions:

- provider types are registered backend drivers;
- provider instances are named org-like workspaces/accounts with one provider type;
- projects belong to one provider instance/org;
- environments/configs belong to one project;
- project has `active_environment`;
- environments table is keyed by `project_id` and `name`;
- provider mappings can store remote project and environment/config identifiers;
- staging is scoped by `(project_id, environment)`;
- cache is scoped by `(project_id, environment)`;
- config TOML includes a schema version, provider instances, and project registrations, but not secrets.

Existing provider APIs currently expose one `SecretMap` per provider instance. We need either:

- provider support for environment-aware fetch/push/test; or
- an adapter layer that maps old single-map providers into project/environment-specific backing records.

For the redesign, prefer adding an environment-aware layer at the envd core boundary while keeping old providers usable through adapters.

Provider instance/org model additions:

- provider instances are keyed by name for CLI selection;
- provider instance stores provider type and provider-specific setup metadata;
- project secrets remain project-scoped by default, even when multiple projects share an org;
- `envd init --provider <name>` selects the provider instance/org for a project;
- default provider instance/org name is `personal`;
- `envd provider list|add|remove|test` should manage provider instances;
- `envd project move --provider <name>` should move a project between provider instances after verified copy.

## README Happy Path

The new README should show:

```sh
npm install -g envd
cd my-app
envd init
envd use dev
envd status
envd run dev -- npm run dev
```

It should not require `envd daemon start` in the first walkthrough.

## Confirmed Decisions

These decisions are incorporated into the redesign:

- `envd use <env>` updates both the project active-environment state and the managed `.env` view.
- `envd run` injects process env only in the MVP; temporary dotenv-file support can be added later behind an explicit flag.
- Hosted/cloud envd provider language stays out of the MVP implementation docs until there is a real backend story; `envd open` remains a deferred local-only browser surface.
- The default scanner checks project root, `config/`, `configs/`, `env/`, `envs/`, `environments/`, `.config/`, and root-level framework env files such as `.env.*`.
- `envd project move --provider <name>` is the project migration command for moving the current project between provider instances.
- When multiple env files map to the same environment and contain conflicting values, interactive init requires the user to rename environments, pick winners, or cancel; non-interactive init fails unless explicit `--env-file <env>=<path>` mappings avoid the conflict.

## Implementation Status

The design is approved. Implement the work in the order defined by [ux-redesign-stories.md](ux-redesign-stories.md), keeping each story independently reviewable and verified.
