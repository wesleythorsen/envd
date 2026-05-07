# UX Redesign User Stories Draft

Status: approved for implementation.

## UX-0 — Documentation And Scope Alignment

### UX-0.1 — Finalize UX redesign docs

**Goal.** The redesign has approved docs before implementation starts.

**Acceptance criteria.**
- `docs/ux-redesign-design.md` captures the agreed command model, state model, safety policy, and open decisions.
- `docs/ux-redesign-stories.md` captures sequenced implementation stories.
- `docs/cli-spec.md`, `docs/requirements.md`, `docs/architecture.md`, and `docs/work-breakdown.md` are updated after approval to match the new UX direction.
- No implementation code changes are included in this story.

**Depends on.** Discussion approval.

## UX-1 — Invisible Daemon Preflight

### UX-1.1 — Shared daemon/mount preflight

**Goal.** Normal commands start and repair required support processes automatically.

**Acceptance criteria.**
- Shared CLI helper checks control API health.
- If daemon is unreachable, helper starts it and waits for readiness.
- Helper can ensure the WebDAV mount for commands that need file access.
- Commands can opt out with `--no-autostart`.
- Errors explain the failed user action, with daemon details as diagnostic context.
- Unit tests cover healthy, autostart, timeout, and mount-failure cases.

**Depends on.** Existing daemon commands.

### UX-1.2 — Apply preflight to core commands

**Goal.** Users do not need to run `envd daemon start` during normal workflows.

**Acceptance criteria.**
- `init`, `link`, `status`, `diff`, `commit`, `pull`, `use`, `run`, `eject`, and `browse` use the shared preflight where applicable.
- README happy path no longer includes `envd daemon start`.
- Existing `envd daemon *` commands continue to work for advanced use.
- Integration tests verify `envd init` can autostart from a stopped daemon.

**Depends on.** UX-1.1.

## UX-2 — Local Project Registry And Environment-Aware State

### UX-2.0 — Replace repo-local project file with TOML project registry

**Goal.** Project metadata is stored in user-level envd configuration instead of repository-local `.envd.json`.

**Acceptance criteria.**
- `envd init` writes project registration to an envd TOML config file, not to the project repository.
- The TOML config records schema version, provider instances, project registrations, project root paths, provider project mappings, active environments, and non-secret display/default settings.
- `envd config edit` opens the TOML config in `$VISUAL` or `$EDITOR`, validates the edited file, and preserves the previous config if validation fails.
- Secrets, staged values, cached snapshots, daemon runtime files, logs, and mount directories do not live in the TOML config.
- Commands resolve the current project by canonical project root, preferring the nearest Git root when present.
- Missing registration errors suggest `envd init`.
- Moved-directory repair is supported through a confirmed relink flow such as `envd project relink`.
- Existing `.envd.json` projects migrate into the TOML registry and then retire or remove the repo-local metadata after confirmation.
- Tests cover fresh init, lookup by project root, missing registration, config edit validation, moved directory relink, and `.envd.json` migration.

**Depends on.** UX-0.1.

### UX-2.1 — XDG-style local directory layout

**Goal.** Editable config, durable state, cache, runtime files, and mount paths are stored in appropriate user-level locations.

**Acceptance criteria.**
- Default config path is `$XDG_CONFIG_HOME/envd/config.toml`, falling back to `~/.config/envd/config.toml`.
- Default state path is `$XDG_STATE_HOME/envd/`, falling back to `~/.local/state/envd/`.
- Default cache path is `$XDG_CACHE_HOME/envd/`, falling back to `~/.cache/envd/`.
- Runtime files prefer `$XDG_RUNTIME_DIR/envd/` when available and otherwise use a safe state-directory fallback.
- WebDAV mount path defaults outside the config directory and remains overrideable.
- Existing `ENVD_HOME` remains available as a coarse override for tests and portable/dev use.
- Migration from the current `~/.envd/` layout is explicit, idempotent, and preserves existing state.
- Tests cover default path resolution, XDG env var overrides, `ENVD_HOME` override, and migration from `~/.envd/`.

**Depends on.** UX-0.1.

### UX-2.2 — Add project environments to state

**Goal.** A project can contain multiple named environments.

**Acceptance criteria.**
- State schema stores environments keyed by project id and environment name.
- Project state stores an active environment.
- Existing single-environment projects migrate to one default environment.
- Project APIs expose environment list and active environment.
- Tests cover migration, create/list/get/set-active flows.

**Depends on.** UX-2.0.

### UX-2.3 — Scope cache and staging by environment

**Goal.** Uncommitted changes are preserved independently per environment.

**Acceptance criteria.**
- Staging keys are scoped by `(project_id, environment)`.
- Cache keys are scoped by `(project_id, environment)`.
- Switching environments does not discard or overwrite staging in another environment.
- `diff`, `commit`, and `pull` operate on active environment by default and named environment when provided.
- Tests cover staging in `dev`, switching to `stage`, and returning to `dev` with edits preserved.

**Depends on.** UX-2.2.

### UX-2.4 — Environment-aware provider adapter

**Goal.** Existing providers can participate in the environment model.

**Acceptance criteria.**
- Core provider access can resolve a `SecretMap` for a specific environment.
- Existing providers work through an adapter or per-environment instance mapping.
- Provider metadata describes whether a provider is environment-native or adapted.
- Tests cover local envd provider and one existing provider path.

**Depends on.** UX-2.2.

## UX-3 — First-Run Env File Adoption

### UX-3.1 — Env file discovery and classification

**Goal.** `envd init` can find and classify existing env files.

**Acceptance criteria.**
- Scanner detects common env filenames: `.env`, `.env.local`, `.env.dev`, `.dev.env`, `dev.env`, and equivalent variants.
- Default scanner checks common env locations only: project root, `config/`, `configs/`, `env/`, `envs/`, `environments/`, `.config/`, and root-level framework env files.
- Scanner supports repeated `--scan <path>` for additional explicit locations.
- Scanner ignores dependency/build directories and `.git` inside any scanned path.
- Parser validates dotenv syntax and reports file-specific errors.
- Classifier proposes environment names with confidence and ambiguity flags.
- If multiple files map to the same environment with conflicting values, interactive mode requires the user to rename environments, pick winners, or cancel.
- Non-interactive mode fails on conflicting inferred mappings unless explicit `--env-file <env>=<path>` flags avoid the conflict.
- Unit tests cover naming conventions, ignore rules, duplicate mappings, and parse failures.

**Depends on.** Existing dotenv parser.

### UX-3.2 — Interactive adoption plan

**Goal.** `envd init` shows a clear import plan before changing files.

**Acceptance criteria.**
- Plan lists files, inferred environments, key counts, duplicate keys, parse warnings, target provider instance/org, provider type, project, active environment, and source-file disposition.
- User can rename environment mappings interactively.
- User can choose active environment.
- User can cancel with no project/provider/file mutations.
- `--json` can output the plan for tooling.
- Tests cover accept, cancel, and remap flows.

**Depends on.** UX-3.1.

### UX-3.3 — Non-interactive adoption flags

**Goal.** The adoption flow is scriptable.

**Acceptance criteria.**
- `envd init` supports repeated `--env-file <env>=<path>`.
- `envd init` supports `--active <env>`.
- `envd init` supports `--provider <name>` for an existing provider instance/org.
- `envd init` supports `--new-provider` for inline provider setup.
- `envd init` supports `--provider-type <type>` and `--provider-name <name>` with `--new-provider` for non-interactive setup.
- `envd init` supports repeated `--scan <path>`.
- `envd init` supports `--yes`.
- Non-interactive mode fails with actionable errors when mappings are ambiguous.
- Tests cover scripted multi-environment import.

**Depends on.** UX-3.2.

### UX-3.4 — Safe source-file retirement

**Goal.** Imported env files are removed from active use without data loss.

**Acceptance criteria.**
- Default behavior moves imported files to `.envd-retired/<timestamp>/`.
- Command output explicitly says the original env files are retired and no longer used.
- Retired directory contains a receipt mapping original files to retired paths, imported environments, key counts, provider instance/org destination, timestamp, and undo command.
- `.envd-retired/` is added to `.gitignore`.
- Optional `--delete-imported-files` deletes files after import verification.
- Command refuses to delete files unless provider import was verified.
- Tests cover retired-file move, receipt, gitignore update, and delete flag.

**Depends on.** UX-3.2.

## UX-4 — Provider Instances As Orgs

### UX-4.1 — Provider instance/org model

**Goal.** Users group projects under named provider instances that match org-like workspaces/accounts.

**Acceptance criteria.**
- State schema stores provider types, named provider instances/orgs, projects, and environments/configs.
- Provider instances have a name, provider type, provider-specific config metadata, and credential reference.
- A default local provider instance/org named `personal` is created on first run.
- Projects belong to one provider instance/org.
- Environments/configs belong to one project.
- Multiple projects can belong to the same provider instance/org while keeping their secrets project-scoped by default.
- `envd init --provider <name>` selects an existing provider instance/org for a project.
- Tests cover default `personal` creation, existing provider selection, multiple projects in one provider instance, and project/environment scoping.

**Depends on.** UX-2.0, UX-2.1, UX-2.2.

### UX-4.2 — envd-managed local provider

**Goal.** First-time users can adopt env files without learning provider configuration.

**Acceptance criteria.**
- New built-in provider stores projects/environments in envd-managed local state.
- Provider supports fetch, push, and test.
- Provider stores multiple environments for one project.
- Values are encrypted at rest consistently with existing local secret storage expectations.
- Provider is selected automatically when the user has no configured provider.
- Tests cover first-run creation, fetch/push, and multi-environment storage.

**Depends on.** UX-4.1, UX-2.4.

### UX-4.3 — Provider setup and selection policy

**Goal.** `envd init` chooses sensible defaults while giving existing provider users a fast path to Doppler, Bitwarden, AWS, or other configured providers.

**Acceptance criteria.**
- `envd init` with no configured provider instances creates or reuses the `personal` envd-managed local provider instance.
- `envd provider add <type> --name <name>` prompts for provider setup, tests connectivity, and stores a named provider instance/org.
- `envd init --provider <name>` initializes the project under an existing provider instance/org.
- `envd init --new-provider` runs provider setup inline during init.
- `envd init --new-provider --provider-type <type> --provider-name <name>` supports non-interactive provider setup when provider-specific flags are also supplied.
- If multiple provider instances exist and none is specified, interactive init prompts with `personal` as the default when present.
- User can override with flags.
- Tests cover first init local default, provider add, init with existing provider, inline new-provider setup, duplicate provider names, and multiple-provider selection.

**Depends on.** UX-4.2, UX-3.2.

### UX-4.4 — Move current project between provider instances

**Goal.** Users can adopt locally first, then move the project to Doppler, Bitwarden, AWS, or another provider without rerunning adoption manually.

**Acceptance criteria.**
- `envd project move --provider <name>` copies the current project's environments/configs to the target provider instance/org.
- Command preserves project and environment/config names by default.
- Command supports explicit project/environment remapping flags when provider naming constraints require it.
- Target provider reads are verified before project binding is updated.
- Source provider data remains intact by default.
- Optional purge flag removes the old provider copy only after successful verification.
- Tests cover local-to-Doppler-adapter move, failed target verification, source-retained default, and purge behavior.

**Depends on.** UX-4.3, UX-2.4.

## UX-5 — Environment Selection And Running

### UX-5.1 — `envd use`

**Goal.** Users can switch the active project environment directly.

**Acceptance criteria.**
- `envd use` opens an interactive selector.
- `envd use <env>` switches directly.
- Command shows staged-change summary for old and new environments when relevant.
- Unknown environment errors suggest `--create` or `envd init`.
- Switching refreshes the managed `.env` view.
- Tests cover interactive, direct, unknown, and staged-preservation flows.

**Depends on.** UX-2.3.

### UX-5.2 — `envd run`

**Goal.** Users can run commands with secrets from a named environment.

**Acceptance criteria.**
- `envd run <env> -- <command...>` injects environment variables into the child process.
- `envd run -- <command...>` uses the active environment.
- Provider/read errors occur before spawning the child.
- Child exit code is propagated.
- Secret values are not logged.
- Tests cover env injection, active environment default, provider failure, and exit-code propagation.

**Depends on.** UX-2.4.

### UX-5.3 — `envd eject`

**Goal.** Users can return a project to ordinary env files without losing managed values.

**Acceptance criteria.**
- `envd eject` shows the env files that will be recreated.
- By default, recreated files use current committed provider values.
- `envd eject --from-retired` restores exact pre-adoption files when a retired-file receipt exists.
- Command removes the managed `.env` symlink.
- Command removes the current project registration from the user's envd TOML config after confirmation.
- `--purge` also removes the project from local envd state.
- Provider instance/org state remains intact unless explicitly purged by a future provider command.
- Tests cover provider-value eject, retired-file restore, symlink removal, metadata removal, and purge behavior.

**Depends on.** UX-3.4, UX-2.4.

## UX-6 — Workflow-Centered Status

### UX-6.1 — Redesign `envd status`

**Goal.** `envd status` reports secrets workflow state first.

**Acceptance criteria.**
- Default human output shows active environment, provider health, staged changes, upstream freshness, `.env` link state, and next suggested action.
- Daemon/mount details are collapsed unless unhealthy.
- `--json` includes full structured fields.
- Tests snapshot clean, staged, provider-failing, unlinked, and not-initialized states.

**Depends on.** UX-2.3, UX-1.1.

### UX-6.2 — Add `envd status --full`

**Goal.** Advanced process diagnostics remain available without dominating the default view.

**Acceptance criteria.**
- `--full` includes daemon pid/version/uptime, ports, mount path, project registration, provider details, staging details, and last fetch.
- Output subsumes the useful fields from current `envd status`.
- Tests cover JSON and human output.

**Depends on.** UX-6.1.

### UX-6.3 — Add `envd doctor`

**Goal.** Users have one command for diagnosis and safe repair.

**Acceptance criteria.**
- `envd doctor` checks daemon, control token, mount, project registration, `.env` link, provider health, migrations, and stale pid/ports files.
- `envd doctor --fix` performs safe repairs.
- Destructive repairs require confirmation or `--force`.
- Output avoids secret values.
- Tests cover healthy, broken symlink, stopped daemon, stale pid, and provider-failure scenarios.

**Depends on.** UX-1.1, UX-6.2.

## UX-7 — TUI And Deferred Browser Surfaces

### UX-7.1 — CLI/TUI browser

**Goal.** Users can browse projects/environments/keys without a browser.

**Acceptance criteria.**
- Initial implementation is read-only.
- `envd browse` lists orgs and projects when run outside an initialized project.
- `envd browse` lists environments and key counts.
- User can select an environment and inspect keys.
- Values require explicit reveal.
- Non-TTY mode prints a readable table or JSON.
- Tests cover non-TTY output and reveal gating.

**Depends on.** UX-2.2.

### UX-7.2 — Deferred local browser API and static shell

**Goal.** `envd open` can show current project secrets in a local-only browser UI.

**Acceptance criteria.**
- Story is explicitly deferred until the core CLI redesign is implemented.
- Daemon exposes loopback-only UI endpoints protected by control token auth.
- `envd open` opens browser to current project and active environment.
- UI lists environments and keys.
- Values are hidden by default.
- Initial version can be read-only.
- Tests cover route auth and project/environment data shape.

**Depends on.** UX-2.2.

## UX-8 — Docs And Migration Messaging

### UX-8.1 — Rewrite README happy path

**Goal.** README teaches the redesigned workflow without daemon concepts first.

**Acceptance criteria.**
- First walkthrough uses `envd init`, `envd use`, `envd status`, and `envd run`.
- Daemon/WebDAV explanation moves to an "Advanced diagnostics" section.
- Local provider behavior is explained in first-run terms.
- Provider instance/org selection is explained as the way to group work, personal, client, or team secrets.
- Migration safety behavior is explicit.

**Depends on.** UX-3.4, UX-4.3, UX-5.2, UX-6.1.

### UX-8.2 — Update CLI, architecture, and requirements docs

**Goal.** Existing specs match the approved UX redesign.

**Acceptance criteria.**
- `docs/cli-spec.md` includes new commands and changed defaults.
- `docs/architecture.md` explains environment-aware state and invisible daemon preflight.
- `docs/requirements.md` captures first-run adoption, environment switching, and local browser/TUI requirements.
- `docs/work-breakdown.md` links or incorporates the approved UX stories.

**Depends on.** Approval of UX redesign docs.

## Suggested Implementation Order

1. UX-0.1
2. UX-1.1, UX-1.2
3. UX-2.0, UX-2.1, UX-2.2, UX-2.3, UX-2.4
4. UX-3.1, UX-3.2, UX-3.3, UX-3.4
5. UX-4.1, UX-4.2, UX-4.3, UX-4.4
6. UX-5.1, UX-5.2, UX-5.3
7. UX-6.1, UX-6.2, UX-6.3
8. UX-7.1
9. UX-8.1, UX-8.2
10. UX-7.2 when the CLI redesign is stable

## Discussion Gates

All design gates are approved. New implementation blockers should be captured as story-specific notes rather than reopening the redesign.
