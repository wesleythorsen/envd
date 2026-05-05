# envd

`envd` replaces committed `.env` files with a dynamic, provider-backed `.env` mount. The CLI talks to a local daemon (`envdd`), the daemon mounts a WebDAV-backed virtual file, and your project keeps interacting with a normal `.env` path.

More design and implementation docs live in [docs/README.md](docs/README.md).

## Requirements

- Node.js `>=24`
- macOS or Linux

## Install

```bash
npm install
npm run build
```

If you want the daemon available as a per-user background service, use:

```bash
envd daemon install
```

Otherwise you can start it manually when needed:

```bash
envd daemon start
```

## Walkthrough

1. Start the daemon.

```bash
envd daemon start
```

2. Initialize a project. `envd init` will register the project, create or select a provider instance, write `.envd.json`, and link `.env`.

```bash
cd /path/to/project
envd init
```

3. Edit `.env` as usual. Changes are staged locally through the mounted virtual file.

```bash
$EDITOR .env
```

4. Review staged changes.

```bash
envd diff
envd status
```

5. Commit the staged values back to the provider.

```bash
envd commit -m "Update local development secrets"
```

If you want to discard staged local edits and refresh from the provider instead:

```bash
envd pull --force
```

## Providers

Built-in providers currently include:

- `local-file`
- `doppler`
- `bitwarden-secret-manager`
- `aws-secrets-manager`

Manage provider instances with:

```bash
envd provider list
envd provider add
envd provider test <id>
```

## Useful Commands

```bash
envd daemon status
envd daemon logs --tail 100
envd link
envd unlink
envd diff --values
envd version
```
