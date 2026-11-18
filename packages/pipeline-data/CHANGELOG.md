# Changelog — @pipeline-builder/pipeline-data

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — Backward-compatibility shims removed.

- `HealthBreakdown` (the `plugin_stats` / `ecosystem_listing_stats` `health_breakdown` column type) is now api-core's `Record<HealthComponent, HealthComponentScore>`, re-exported. It was widened to `Record<string, …>` only to accept rows written with an older component set.

### BREAKING CHANGES — `./lib/*` removed; `./testing` is workspace-only.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./package.json`.
- The `./lib/*` wildcard is gone, so `@pipeline-builder/pipeline-data/lib/...` deep imports no longer resolve.
- `./testing` is no longer in the published map. The tarball never contained `lib/testing/` (it needs the PGlite devDependency and the repo's `deploy/` init script), so the old entry pointed at nothing. It stays a workspace-only entry for this repo's test suites.
