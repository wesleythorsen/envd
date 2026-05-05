# Vision

## Problem

Most codebases — open-source examples, internal projects, starter templates — read configuration and secrets from a plain `.env` file at startup. That's simple and ubiquitous, but it has real costs:

- **Swapping the secrets backend means touching the code.** If a team adopts Doppler, Vault, AWS Secrets Manager, etc., they usually have to change startup code, CI pipelines, and local-dev scripts to pull secrets at runtime instead of reading `.env`. That friction keeps many teams on checked-in-or-manually-passed-around `.env` files longer than they should be.
- **Local `.env` files drift.** Developers copy each other's `.env` files over Slack/email. They go stale. They leak. Rotating a value means asking everyone to update their file.
- **Non-secret config lives awkwardly.** AWS region, stage name, feature flags — they behave like config but often end up inside the secret manager just because that's where per-environment values already live.

## The idea

Put a **virtual `.env`** at the path the application already reads from. Behind the scenes, a local daemon fetches the real values from whatever backend the developer configured, and renders a live `.env` on each read. The app code is unchanged. Swapping providers is a one-line config change for the developer, not a cross-cutting code change.

Mechanically: the daemon exposes files over **WebDAV** (because macOS and Linux both mount WebDAV natively, no FUSE install required). The developer's project points at that mount (via a symlink, for example). When the app opens `.env`, the OS issues a WebDAV `GET` to the daemon, which fetches secrets from the provider, renders a `.env`, and streams it back.

Writes go the other way: editing the "virtual `.env`" in an editor is captured by the daemon as a **staged change**, which the developer can then review (`envd diff`) and push (`envd commit`) to the remote provider. This turns secrets management into a file-edit + commit workflow rather than a click-through UI or CLI-only chore.

## Why this is worth building

- There are plenty of secrets *managers*. There aren't many **drop-in, code-change-free adapters** between "apps that read `.env`" and "managed secret backends."
- Mount-based dynamic files are a well-understood pattern inside infra tooling (log streams, backup snapshots exposed over WebDAV) but are rare in developer-facing local tooling.
- The staged-diff editing experience is novel for secret management and borrows a UX teams already know from git.

## Scope

### v1 — in scope

- CLI (`envd`) with `init`, `link`, `status`, `diff`, `commit`, `pull`, `provider`, `daemon` commands.
- Daemon (`envdd`) exposing:
  - A local WebDAV server (127.0.0.1 only).
  - A local control HTTP API for the CLI to talk to it.
- A pluggable provider interface, with the initial implementation being a **local file-backed provider** (for tests and zero-dependency demos) and a **Doppler provider** (real-world use case).
- `.env` format only.
- Platform support: **macOS** first, **Linux** (via `davfs2` or similar) shortly after.
- Per-project access tokens so only the right project can read the right secrets from the local WebDAV tree.
- Encrypted local cache of provider credentials (OS keychain where possible, encrypted file fallback).

### v1 — explicitly out of scope

- Windows support (architecture must not preclude it, but no code for it in v1).
- A hosted SaaS offering.
- Our own standalone secrets backend (planned; not v1).
- Multi-user / team sync (single developer / single machine in v1).
- Config files (YAML/JSON), feature flags — architecture must leave room for these; code for them comes later.

### Future (architectural slots, not v1 work)

- **More providers**: AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, 1Password Connect.
- **Our own secrets provider**: self-hosted first, optional managed SaaS later.
- **Other data kinds**: non-secret config (YAML/JSON/TOML), feature flags (with live re-reads), templated local-dev config.
- **Diff/commit UX improvements**: staging per-value, commit messages, provider-side audit log integration.
- **IDE integrations**: a VS Code extension that surfaces staged diffs.
- **Windows**: evaluate `net use` against WebDAV, or a native FS driver.

## Non-goals / design constraints

- **Never require changes to the consuming app's code.** A `dotenv.config()` call should just work.
- **Never require kernel-level installs.** WebDAV is native on macOS and Linux; FUSE is not. That constraint is load-bearing for the whole design.
- **Fail loud, not silent.** If secrets can't be fetched, the `.env` read should return an error (or an explicit placeholder that the app will treat as misconfigured), not an empty or stale file.
- **Secrets never leave the local machine unencrypted.** No telemetry that captures values. Cached values are encrypted at rest.
- **Keep the daemon boring.** It's a piece of developer infrastructure. Prefer obvious code, good logs, and few moving parts over clever optimization.

## Positioning

Think of `envd` as:

- A **thin UX layer** over whatever secrets backend you already use.
- The missing **file-shaped adapter** for modern secret managers.
- A path for teams stuck on checked-in `.env` files to modernize without a big migration.
