# Requirements tree

This is the **declarative** spec for the d-env MVP. Every node describes a **what**, not a **how**. Leaves are meant to be testable as pass/fail.

- Use this to **validate** any proposed plan or implementation: does it satisfy every leaf?
- Use this to **anchor scope debates**: changes to scope should land here first, then in the imperative plan.
- Keep leaves terse. If a node gets long, split it.
- Non-goals are captured under explicit `NOT` nodes. They're as important as the positive requirements.

Relationship to other docs:

- [vision.md](vision.md) — narrative *why*; this doc is the structured *what*.
- [architecture.md](architecture.md), [cli-spec.md](cli-spec.md), [daemon-spec.md](daemon-spec.md) — *how*, at system and interface level.
- [implementation-plan.md](implementation-plan.md), [work-breakdown.md](work-breakdown.md) — *how*, sequenced in time.

If this tree and those docs disagree, **this tree wins**, and the docs are a bug. Propose a fix.

---

## Root: A working MVP of `d-env`

The tool from [vision.md](vision.md): a virtual `.env` file backed by a pluggable provider, served by a local daemon and managed by a CLI, for macOS and Linux.

### 1. Developer-facing behavior

- **1.1 The consumer app reads `.env` without code changes**
  - 1.1.1 `.env` opens via standard file I/O from any language or runtime.
  - 1.1.2 Reading `.env` returns current values from the configured backend.
  - 1.1.3 If the backend is unreachable, the read fails loudly (never silently stale, never silently empty).
  - 1.1.4 Concurrent reads from the same app during startup return consistent data.

- **1.2 Secrets live outside the repo**
  - 1.2.1 Values are stored in a pluggable backend, not the working tree.
  - 1.2.2 `.env` is kept out of version control by default (the tool ensures this).
  - 1.2.3 The developer's view is consistent regardless of which backend is active.

- **1.3 Editing secrets is file-edit → review → commit**
  - 1.3.1 Saving `.env` from any editor records the change locally.
  - 1.3.2 Local (staged) changes are visible on subsequent reads.
  - 1.3.3 Staged changes are never pushed to the backend without explicit user action.
  - 1.3.4 The developer can view staged vs. remote as a structured diff (keys only, or keys + values).
  - 1.3.5 The developer can push staged changes to the backend in one command.
  - 1.3.6 The developer can discard staging and re-sync from the backend in one command.
  - 1.3.7 Upstream drift is detected before a push.
  - 1.3.8 On drift, the developer can choose to keep local, keep remote, or abort.

- **1.4 Onboarding a new project takes one command**
  - 1.4.1 Initialization selects or creates a backend instance.
  - 1.4.2 Initialization is idempotent (safe to re-run).
  - 1.4.3 Initialization prevents `.env` from being checked in.
  - 1.4.4 Initialization works fully non-interactively given config via flags/env vars.

- **1.5 Onboarding a new machine from an existing project takes one command**
  - 1.5.1 After cloning a repo that uses d-env, one command restores the working `.env`.
  - 1.5.2 No secret material is required from the existing repo — creds come from the developer's own keychain.

- **1.6 Current state is inspectable in one command**
  - 1.6.1 The developer can see: is the daemon running, is the mount up, is this project known, any staged changes, last backend sync time.

### 2. Extensibility (scope-relevant today, even if code is future)

- **2.1 New backends plug in without modifying the daemon or CLI**
  - 2.1.1 Adding a backend is a self-contained module conforming to a stable interface.
  - 2.1.2 MVP ships with at least a file-backed backend (for dev/test) and one real cloud backend (Doppler).
  - 2.1.3 A future self-hosted backend will plug in the same way as any other.

- **2.2 New data kinds plug in without rewriting the daemon or CLI**
  - 2.2.1 MVP implements the "secrets" data kind; the architecture does not hardcode against it.
  - 2.2.2 Adding configs (non-secret per-environment values), feature flags, or templated files is additive.

- **2.3 New output formats plug in**
  - 2.3.1 MVP renders `.env` format; JSON/YAML/shell/systemd-env can be added without touching unrelated code.

- **2.4 New host platforms plug in**
  - 2.4.1 MVP supports macOS and Linux; Windows is out of scope (see 8.3) but no design choice makes it impossible.

- **2.5 NOT in MVP**
  - 2.5.1 Dynamic plugin loading / third-party plugins / plugin marketplace.
  - 2.5.2 Multi-user or team-sync semantics.
  - 2.5.3 A hosted SaaS.
  - 2.5.4 Our own first-party secrets backend.

### 3. Security and privacy

- **3.1 Secret values never appear in logs**
  - 3.1.1 Log entries include keys, counts, timings — never values.
  - 3.1.2 Automated tests fuzz-check this invariant.

- **3.2 Secret material is encrypted at rest on the developer's machine**
  - 3.2.1 Cached backend snapshots are encrypted.
  - 3.2.2 Staged changes are encrypted.
  - 3.2.3 Backend credentials are stored in the OS keychain when available; encrypted-file fallback otherwise.

- **3.3 Local attack surface is minimized**
  - 3.3.1 All HTTP endpoints bind only to loopback.
  - 3.3.2 Accessing a project's data requires a per-project token.
  - 3.3.3 Control API requires a bearer token readable only by the current user.

- **3.4 NOT in MVP**
  - 3.4.1 Telemetry of any kind.
  - 3.4.2 Network exposure of any endpoint beyond loopback.
  - 3.4.3 Hardware-backed key storage (Secure Enclave, TPM).

### 4. Operational quality

- **4.1 Reads are fast enough for app startup**
  - 4.1.1 Warm-cache reads return in under ~100 ms on a typical laptop.
  - 4.1.2 Cold reads return within a reasonable backend round-trip plus modest overhead.

- **4.2 Concurrent cold reads don't stampede the backend**
  - 4.2.1 N simultaneous reads through an expired cache cause exactly one backend fetch.

- **4.3 The daemon runs unattended**
  - 4.3.1 It can be installed to start at user login on macOS and Linux.
  - 4.3.2 It survives idle periods without leaks or socket accumulation.
  - 4.3.3 Graceful shutdown flushes state and releases resources.

- **4.4 Failures are distinguishable**
  - 4.4.1 A taxonomy of error codes separates backend-auth, backend-unreachable, conflict, usage, mount, not-initialized, and internal errors.
  - 4.4.2 The CLI maps each to a distinct, scriptable exit code.

- **4.5 Observable diagnosis is possible without raw data access**
  - 4.5.1 Structured logs let a support engineer diagnose failures without ever seeing secret values.

### 5. Workflow integrity

- **5.1 The tool never loses a developer's unpushed work silently**
  - 5.1.1 An unexpected daemon restart preserves staged changes.
  - 5.1.2 A corrupted state store fails loudly, not with data loss.

- **5.2 The tool never pushes unintended changes**
  - 5.2.1 No operation pushes to the backend without explicit user action.
  - 5.2.2 Destructive local operations (discard staging, deregister project) require confirmation or a force flag.

- **5.3 Re-reads after writes are consistent**
  - 5.3.1 A read immediately after staging a change sees the change.
  - 5.3.2 A read immediately after a commit sees the backend's new state.

### 6. No changes required outside the tool

- **6.1 No consumer app code changes**
  - 6.1.1 A project that previously read `.env` via any mainstream library continues to work unmodified.

- **6.2 No kernel extensions or third-party filesystem drivers**
  - 6.2.1 macOS setup requires only tools shipped with the OS.
  - 6.2.2 Linux setup requires at most a standard package manager install (e.g. davfs2) — no custom kernel modules.

- **6.3 No shared-service or network dependency for offline dev**
  - 6.3.1 With a file-backed backend, the entire workflow runs offline.

### 7. Developer experience

- **7.1 Install → working state in under five minutes**
  - 7.1.1 Documented happy path from `npm i -g` to a rendered `.env`.

- **7.2 Discoverability**
  - 7.2.1 `--help` / built-in help covers every command with examples.
  - 7.2.2 Errors include actionable next steps, not just a code.

- **7.3 Scriptable**
  - 7.3.1 Every command supports a JSON output mode.
  - 7.3.2 Every interactive prompt has a non-interactive flag equivalent.

- **7.4 Readable diffs**
  - 7.4.1 Staged vs. remote diffs are rendered in a `git diff`-like format by default.
  - 7.4.2 Values are hidden unless explicitly requested.

### 8. Platform support

- **8.1 macOS first-class**
  - 8.1.1 Works on current macOS (≥ 14) with no third-party installs.
  - 8.1.2 Installable to start at user login.

- **8.2 Linux first-class with one package install**
  - 8.2.1 Works on common distros with `davfs2` installed.
  - 8.2.2 Installable to start at user session (systemd --user).

- **8.3 Windows NOT in MVP**
  - 8.3.1 No MVP code for Windows.
  - 8.3.2 Architecture does not preclude a later Windows port (mount layer is isolated).

### 9. Documentation and handoff

- **9.1 A new contributor onboards from the repo alone**
  - 9.1.1 A project root README walks through install, init, edit, commit.

- **9.2 A new LLM session onboards from a single entry-point doc**
  - 9.2.1 One cold-start doc is sufficient to resume design or implementation work.

- **9.3 Stable surfaces are named and versioned**
  - 9.3.1 Interfaces that extensions (future backends, data kinds, platforms) will depend on are documented.
  - 9.3.2 On-disk formats (project file, state DB schema) have documented migration semantics.

- **9.4 Provenance is preserved**
  - 9.4.1 The original design conversation and the final design docs are both kept in-repo.
