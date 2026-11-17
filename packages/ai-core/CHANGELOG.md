# Changelog — @pipeline-builder/ai-core

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — Root entry only.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./package.json`.
- Every compiled file under `lib/` was importable (the package had no `exports` map). Only the root barrel is public now.
