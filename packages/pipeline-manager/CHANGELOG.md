# Changelog — @pipeline-builder/pipeline-manager

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — Explicit, empty library surface.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `./package.json` only.
- This package is a CLI (`bin: pipeline-manager`). It never had a usable library entry, and now it declares that outright: an `exports` map with only `./package.json`, so `dist/...` deep imports no longer resolve. The CLI itself is unchanged.
