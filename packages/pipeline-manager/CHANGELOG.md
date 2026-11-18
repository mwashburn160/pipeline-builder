# Changelog — @pipeline-builder/pipeline-manager

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — Explicit, empty library surface.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `./package.json` only.
- This package is a CLI (`bin: pipeline-manager`). It never had a usable library entry, and now it declares that outright: an `exports` map with only `./package.json`, so `dist/...` deep imports no longer resolve. The CLI itself is unchanged.

### Fixes (CLI behaviour)

- **Exit codes:** a request that got no response for any reason other than a timeout (connection refused, DNS failure, reset) now exits `7` (network). It used to exit `10` (timeout) because every request carries a configured timeout. `auth login` now exits with the standard code for what failed: `7` when the platform can't be reached, `3` on a 5xx. It used to exit `4` (auth) for any HTTP failure.
- **`audit tokens`:** a secret the scan can't read (access denied, throttled) now makes the run exit `2` (scan failure) and appears under `unreadable` in `--json`. A secret that isn't valid JSON or has no `expiresAt` is reported as `unverifiable` (exit `1`). Before, all three were skipped with a warning, and the run could exit `0` ("all clear").
- **TLS:** `status` now checks the credential (`/api/user/profile`) under the same TLS policy as every other authenticated command (`PLATFORM_CA_BUNDLE`, `PLATFORM_TLS_VERIFY`, refused in production). Before, it sent the bearer token with certificate verification off to any localhost or private-range host. The credential-free `/health` probe still relaxes verification for local hosts, but a private range now only counts as local when the host is a literal IPv4 address. Before, DNS names such as `10.example.com` also counted. `[::1]` is now recognised as loopback.
- **Inline login timeout:** the inline `--identifier/--password` login (`store-token`, `setup-events`, `provision`) now uses the configured request timeout instead of waiting forever.
