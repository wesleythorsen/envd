# envd — project docs

`envd` is a developer tool that replaces static `.env` files with a **dynamic, WebDAV-backed virtual file**. The real secrets live in a pluggable backend (Doppler, AWS Secrets Manager, a self-hosted store, …). The developer's project sees a normal `.env` file.

## Reading order for a new contributor / LLM session

1. [session-handoff.md](session-handoff.md) — **start here** if you are resuming this project in a new LLM session. Gives a compact grounding so you can pick up without re-reading the original brainstorm.
2. [vision.md](vision.md) — problem, product shape, what's in/out of scope now vs. later.
3. [requirements.md](requirements.md) — declarative **what** as a tree of testable leaves. Use this to validate any plan or implementation. Wins over other docs on disagreement.
4. [architecture.md](architecture.md) — components, protocols, data flow, process model.
5. [cli-spec.md](cli-spec.md) — CLI surface (commands, flags, exit codes).
6. [daemon-spec.md](daemon-spec.md) — daemon endpoints, WebDAV behavior, state store.
7. [extension-points.md](extension-points.md) — how future providers, data types, and features plug in.
8. [implementation-plan.md](implementation-plan.md) — phased plan from empty repo to v0.1 (milestone-level).
9. [work-breakdown.md](work-breakdown.md) — milestones broken into independently committable user stories + tasks, with dependency order and agent-facing guidance. Use this when delegating execution to sub-agents.
10. [initial-idea-convo.md](initial-idea-convo.md) — the raw brainstorm the idea came from. Kept for provenance; not required reading.

## Project quick facts

- **Language**: TypeScript, Node >= 24, ESM.
- **Shape**: monorepo-free single package with two binaries (`envd` CLI + `envdd` daemon) and a shared core library.
- **Primary use case (v1)**: dynamic `.env` for secrets, powered by a pluggable provider backend.
- **Designed for extension**: additional data types (configs, feature flags), additional providers (incl. a future self-hosted one).
- **Target platforms**: macOS and Linux first (WebDAV mount is native on both). Windows later.
