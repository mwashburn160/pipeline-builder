# Changelog — @pipeline-builder/api-core

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 6.0.0 (unreleased)

### BREAKING CHANGES — Backward-compatibility shims removed.

Installs are new-install only, so the compatibility paths for older callers, producers and env names are gone.

- `isSystemOrgId(orgId)` takes one argument. The ignored, deprecated `orgName` second parameter is removed; drop it at the call site.
- `TokenRevocationStore.getSessionRevocation` and `TokenRevocationStore.isCredentialRevoked` are required. A store that lacked them used to link anyway, with impersonation tokens rejected and credential revocation skipped. Implement both (`createRedisTokenRevocationStore` already does).
- `OPENAI_COMPATIBLE_MODEL` (singular) is no longer read. Set `OPENAI_COMPATIBLE_MODELS` (a comma list of `id[|Display Name]`, so one id still works).
- `PLATFORM_INTERNAL.supportEntitlement` response: `premium`, `premiumLimit`, `limit`, `used`, `ownOrgContacts` and `canDesignate` are required. They used to default to `false` / `0` for a platform that predated the premium upgrade. A reply that omits them now fails validation.
- `PLATFORM_INTERNAL.offerSeatActivity` response: `unknownActivity` is removed. It counted memberships with no activity stamp as "predating the field"; a membership with no stamp is now simply one that has not been used in the window, and is counted as inactive (`seatsHeld - activeMembers`).

### BREAKING CHANGES — Explicit `exports` map; `./lib/*` removed; new `./env` entry.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./permissions`, `./metadata-keys`, `./feature-flags`, `./plugin-catalog`, `./ask-proposals`, `./ai-catalog`, `./plugin-scan`, `./quota-catalog`, `./build-catalog`, `./usage-projection`, `./tier-limits`, `./wire-vocabulary`, `./s3`, `./env`, `./package.json`.
- The `./lib/*` wildcard is gone, so `@pipeline-builder/api-core/lib/...` deep imports no longer resolve. Use the root barrel or one of the named entries above.
- New `./env` entry: `envInt` / `envBool` / `envStr` from a dependency-free leaf, for modules that must not load the barrel (it replaces `@pipeline-builder/api-core/lib/utils/env.js`).
- `./testing` is no longer in the published map. The tarball never contained `lib/testing/`, so the old entry pointed at a file that was not there. It stays a workspace-only entry for this repo's test suites, because it imports the `@jest/globals` devDependency and mints test tokens.
