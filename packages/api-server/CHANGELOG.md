# Changelog — @pipeline-builder/api-server

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — Backward-compatibility shims removed.

- The idempotency `CachedEntry.bodyKind` is required on every entry an `IdempotencyStore` is given or returns, the reservation placeholder included (`'empty'`, or `'json'` for a placeholder that carries a JSON body). An entry without it used to replay as `json`. That fallback served entries cached before the field existed, and it is gone.

### BREAKING CHANGES — Explicit `exports` map; new `./markdown` and `./otel-bootstrap` entries.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./markdown`, `./otel-bootstrap`, `./package.json`.
- Every compiled file under `lib/` was importable (the package had no `exports` map). Only the entries above are public now.
- `@pipeline-builder/api-server/lib/markdown.js` becomes `@pipeline-builder/api-server/markdown` (`renderUntrustedMarkdown`, `UNTRUSTED_MARKDOWN_MAX_BYTES`, `UNTRUSTED_LINK_REL`). It stays out of the root barrel on purpose, so that only services that render markdown load the ESM-only unified stack.
- The OpenTelemetry preload becomes `node --import @pipeline-builder/api-server/otel-bootstrap` (it was `.../lib/otel-bootstrap.js`). Update any custom `start` script or container `CMD`.
