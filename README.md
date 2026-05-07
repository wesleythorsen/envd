# envd

`envd` takes over local `.env` files and turns them into managed project environments. You keep editing and running your app the way you already do, while `envd` stores the values in a provider-backed project/environment model and tracks local changes before you commit them.

More design and implementation docs live in [docs/README.md](docs/README.md).

## Requirements

- Node.js `>=24`
- macOS or Linux

## Install

```bash
npm install
npm run build
```

## First Project

Start in a project that already has one or more env files such as `.env`, `.env.dev`, `.env.local`, or files under `env/`.

```bash
cd /path/to/project
envd init
```

On first run, `envd init` uses the built-in `envd` provider with a default provider instance named `personal`. That instance is a local, encrypted store owned by your machine. It is meant to make first adoption seamless before you connect Doppler, Bitwarden, AWS Secrets Manager, or another provider.

`envd init` scans common env-file locations, shows an adoption plan, imports the values into project environments, verifies the import, and then retires the old source files into `.envd-retired/<timestamp>/` with a receipt. The retired files are no longer used, but `envd eject --from-retired` can restore them exactly.

Switch environments with:

```bash
envd use
envd use dev
```

Check workflow state:

```bash
envd status
envd diff
```

Run your app with a managed environment:

```bash
envd run dev -- npm run dev
envd run -- node ./src/index.js
```

Commit local changes back to the provider:

```bash
envd commit -m "Update local development secrets"
```

Discard staged local edits and refresh from the provider:

```bash
envd pull --force
```

## Provider Instances And Orgs

A provider instance represents one provider type plus one account/org/workspace boundary. The default instance is `personal`; teams often create separate instances for work, clients, or shared projects.

```bash
envd provider list
envd provider add doppler --name my-work
envd init --provider my-work
envd project move --provider my-work
```

Built-in provider types include:

- `envd`
- `local-file`
- `doppler`
- `bitwarden-secret-manager`
- `aws-secrets-manager`

## Browse And Recover

Inspect projects, environments, and keys without revealing values:

```bash
envd browse
envd browse dev
```

Reveal values only when you explicitly ask:

```bash
envd browse dev --reveal
```

Return to ordinary env files:

```bash
envd eject
envd eject --from-retired
```

## Advanced Diagnostics

Most commands start or check the local daemon automatically. You normally do not need to think about the daemon, WebDAV mount, pid files, or ports.

Use these when diagnosing the local machinery:

```bash
envd status --full
envd doctor
envd doctor --fix
envd daemon status
envd daemon logs --tail 100
envd link
envd unlink
```
