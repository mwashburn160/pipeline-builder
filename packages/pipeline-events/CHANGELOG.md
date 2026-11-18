# Changelog — @pipeline-builder/pipeline-events

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — Explicit `exports` map, root entry only.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./package.json`.
- Every compiled file under `lib/` was importable (the package had no `exports` map). `lib/index.js` is the bundled Lambda handler and is still shipped; `pipeline-manager infra setup-events` copies it by path.

### Fixes

- GitHub commit-range resolution no longer under-reports a deploy of more commits than one compare page lists: when `total_commits` exceeds the listed commits, `commitTimestamp`/`commitCount` are omitted (unknown), matching a truncated CodeCommit walk, instead of counting only the listed page.
