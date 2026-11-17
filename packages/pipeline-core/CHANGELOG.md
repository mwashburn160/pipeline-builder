# Changelog — @pipeline-builder/pipeline-core

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 5.0.0 (unreleased)

### BREAKING CHANGES — Explicit `exports` map; `./lib/*` removed; new `./runtime` entry.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./cdk`, `./template`, `./runtime`, `./package.json`.
- The `./lib/*` wildcard is gone, so `@pipeline-builder/pipeline-core/lib/...` deep imports no longer resolve.
- New `./runtime` entry for Lambda handlers, built from leaf modules and free of the root barrel's config layer. It covers platform-credential handling (`createPlatformCredential`, `assertAccessKey`, `readCredentialSecret`, `readAccessKeyFromSecret`, `isCredentialRefusal`, `ACCESS_KEY_PREFIXES`), audit correlation (`correlationHeaders`, `sanitizeCorrelationValue`), platform TLS (`platformTlsVerify`, `platformCaList`, `platformCaBundle`) and the synth-failure line protocol (`parseSynthFailure`, `formatSynthFailure`, `synthFailure`, `SYNTH_FAILURE_MARKER`). The credential helpers need `@aws-sdk/client-secrets-manager`, which the AWS Lambda runtime provides.
