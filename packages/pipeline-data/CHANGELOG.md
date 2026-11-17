# Changelog — @pipeline-builder/pipeline-data

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — `./lib/*` removed; `./testing` is workspace-only.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./package.json`.
- The `./lib/*` wildcard is gone, so `@pipeline-builder/pipeline-data/lib/...` deep imports no longer resolve.
- `./testing` is no longer in the published map. The tarball never contained `lib/testing/` (it needs the PGlite devDependency and the repo's `deploy/` init script), so the old entry pointed at nothing. It stays a workspace-only entry for this repo's test suites.
