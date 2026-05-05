# Changelog

## 0.1.0

Initial public milestone for `envd`.

- Added the `envd` CLI and `envdd` daemon.
- Added project registration, `.env` linking, mount management, and status reporting.
- Added provider-backed secret workflows: fetch, diff, commit, and pull.
- Added built-in providers for local files, Doppler, Bitwarden Secret Manager, and AWS Secrets Manager.
- Added launchd and systemd user-service installation commands.
- Renamed the product surface to `envd` / `envdd`.
