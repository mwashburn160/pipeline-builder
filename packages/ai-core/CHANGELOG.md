# Changelog — @pipeline-builder/ai-core

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — Root entry only.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./package.json`.
- Every compiled file under `lib/` was importable (the package had no `exports` map). Only the root barrel is public now.

### Fixes

- `chunkMarkdown` (and so `buildDocsIndexFromFiles`) gives every chunk a unique id: a heading repeated within one file now gets a `-1`, `-2`, … suffix (GitHub-style) instead of sharing its first occurrence's `<file>#<slug>` id. Duplicate headings in the shipped docs made two Ask sources share one id — the frontend's React key and the citation the model is told to use.
