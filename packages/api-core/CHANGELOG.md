# Changelog — @pipeline-builder/api-core

Release versions are stamped by `nx release` (conventional commits). This file records
breaking changes in the public surface only.

## 6.0.0 (unreleased)

### Features

- `PLATFORM_INTERNAL.offerSeatActivity` response: new required `newMembers` count. These are memberships created inside the window that have not been active in it (no `lastActiveAt`, or one older than the window), so a member who was just added is not counted as a disengaging seat. Inactive seats are `seatsHeld - activeMembers - newMembers`.

- `QUOTA_INTERNAL.purgeOrg` (`POST /quotas/internal/orgs/:orgId/purge`) and `BILLING_INTERNAL.purgeOrg` (`POST /billing/internal/orgs/:orgId/purge`): the org-purge cascade legs for quota and billing, callable by `platform` only. They were the last two cascade legs without a typed contract (plain `DELETE`s to user routes). Quota answers the shared `OrgPurgeResponse`. Billing answers the new `OrgPurgeWithRemainderResponse` (`{ orgId, tables, remaining }`): a subscription whose provider cancel failed is kept and counted in `remaining`, and a 200 with any non-zero count there is not an ack, so the leg retries.

### BREAKING CHANGES — Backward-compatibility shims removed.

Installs are new-install only, so the compatibility paths for older callers, producers and env names are gone.

- `quota.delete` is removed from `REMOTE_AUDIT_ACTIONS`, along with the route that emitted it (`DELETE /quotas/:orgId`). The quota document now leaves through `QUOTA_INTERNAL.purgeOrg`, which records `org.data.purge`.

- `isSystemOrgId(orgId)` takes one argument. The ignored, deprecated `orgName` second parameter is removed; drop it at the call site.
- `TokenRevocationStore.getSessionRevocation` and `TokenRevocationStore.isCredentialRevoked` are required. A store that lacked them used to link anyway, with impersonation tokens rejected and credential revocation skipped. Implement both (`createRedisTokenRevocationStore` already does).
- `OPENAI_COMPATIBLE_MODEL` (singular) is no longer read. Set `OPENAI_COMPATIBLE_MODELS` (a comma list of `id[|Display Name]`, so one id still works).
- `PLATFORM_INTERNAL.supportEntitlement` response: `premium`, `premiumLimit`, `limit`, `used`, `ownOrgContacts` and `canDesignate` are required. They used to default to `false` / `0` for a platform that predated the premium upgrade. A reply that omits them now fails validation.
- `PLATFORM_INTERNAL.offerSeatActivity` response: `unknownActivity` is removed. It counted memberships with no activity stamp as "predating the field"; a membership with no stamp is now simply one that has not been used in the window, and is counted as inactive, or as new if it joined inside the window (see `newMembers` under Features).
- `StepUpTokenPayload.method` is required. A step-up token without a known `method` (`password`, `webauthn`, `totp` or `reauth`) used to pass any gate that did not name `{ methods }`. Now every `requireStepUp` gate refuses it as `401 STEP_UP_INVALID`, the same as a forged or expired token, and records the denial. Platform's `issueStepUpToken` always sets `method`. Test fixtures that sign step-up tokens by hand must set it too.

### BREAKING CHANGES — Every internal contract lives under `/internal`; `outsideInternalPath` removed.

One rule now covers every service-to-service contract: it is served under `/internal/…` or `/<service>/internal/…`, and the gateway refuses that segment from outside (`/api/<service>/internal/*` → 404 on all four nginx targets).

- `InternalEndpointContract.outsideInternalPath` is removed, and `defineInternalEndpoint` refuses any path whose first or second segment is not `internal`. There is no opt-out.
- `isInternalConventionPath` is stricter: `internal` must be the FIRST or SECOND segment (case-insensitive), the positions the gateway refusal matches. `/a/b/internal/x` no longer qualifies.
- Moved contract paths (the server mounts and the Istio policies moved with them; `callInternal` callers pick the new paths up from the contract):
  - `COMPLIANCE_INTERNAL.entityEvent`: `POST /compliance/events/entity` → `POST /compliance/internal/events/entity`
  - `COMPLIANCE_INTERNAL.autoSubscribe`: `POST /compliance/subscriptions/auto-subscribe` → `POST /compliance/internal/subscriptions/auto-subscribe`
  - `COMPLIANCE_INTERNAL.syncEntitlements` / `readEntitlements`: `PUT|GET /compliance/entitlements/:orgId` → `PUT|GET /compliance/internal/entitlements/:orgId`
  - `COMPLIANCE_INTERNAL.posture`: `GET /compliance/posture` → `GET /compliance/internal/posture`
  - `REPORTING_INTERNAL.syncRetention` / `readRetention`: `PUT|GET /reports/retention-sync/:orgId` → `PUT|GET /reports/internal/retention-sync/:orgId`
  - `REPORTING_INTERNAL.syncStakeholderEntitlement`: `PUT /reports/stakeholder-sync/:orgId` → `PUT /reports/internal/stakeholder-sync/:orgId`
  - `REPORTING_INTERNAL.ownerLeft`: `POST /reports/stakeholder-internal/owner-left/:orgId/:userId` → `POST /reports/internal/stakeholder/owner-left/:orgId/:userId`
- `PLUGIN_INTERNAL.initialToolchainDefault` is removed. `POST /plugins/toolchain/initial-default` is unchanged, but it is an ingress route (an operator shell reaches it through the gateway as the `deploy-bootstrap` principal), not a service-to-service contract, so its body schema now lives with the route in api/plugin.

### BREAKING CHANGES — Explicit `exports` map; `./lib/*` removed; new `./env` entry.

The package's public surface is now exactly its `exports` map. Anything not listed below cannot be imported (`ERR_PACKAGE_PATH_NOT_EXPORTED`).

- **Entries:** `.`, `./permissions`, `./metadata-keys`, `./feature-flags`, `./plugin-catalog`, `./ask-proposals`, `./ai-catalog`, `./plugin-scan`, `./quota-catalog`, `./build-catalog`, `./usage-projection`, `./tier-limits`, `./wire-vocabulary`, `./s3`, `./env`, `./package.json`.
- The `./lib/*` wildcard is gone, so `@pipeline-builder/api-core/lib/...` deep imports no longer resolve. Use the root barrel or one of the named entries above.
- New `./env` entry: `envInt` / `envBool` / `envStr` from a dependency-free leaf, for modules that must not load the barrel (it replaces `@pipeline-builder/api-core/lib/utils/env.js`).
- `./testing` is no longer in the published map. The tarball never contained `lib/testing/`, so the old entry pointed at a file that was not there. It stays a workspace-only entry for this repo's test suites, because it imports the `@jest/globals` devDependency and mints test tokens.
