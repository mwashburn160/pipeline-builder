---
layout: default
title: API Reference
---

# API Reference

REST API for managing pipelines, plugins, and reporting. All services run behind an Nginx gateway that handles TLS termination and routing; token validation is done by each service (the gateway only decodes claims for its access log — see [Authentication](authentication.md#how-tokens-are-signed-and-who-can-sign-one)).

**Related docs:** [Environment Variables](environment-variables.md) | [Plugin Catalog](plugins/README.md) | [AWS Deployment](aws-deployment.md)

---

## Overview

This reference catalogs the REST endpoints exposed by the Pipeline Builder services — pipeline, plugin, compliance, quota, organization/access, and reporting — with each route's method, path, description, and (where applicable) the fine-grained permission or quota it consumes. It's for API integrators and operators calling the platform directly: every request goes through the Nginx gateway and needs a `Bearer` JWT plus an `x-org-id` tenant header. Endpoints are grouped by service, followed by common query parameters, worked `curl` examples, and the shared success / paginated / error response envelope. For the permission names in the Organization table, see **[Roles & Permissions](permissions.md)**.

---

## Authentication

All requests require two headers:

| Header | Description |
|--------|-------------|
| `Authorization` | `Bearer <JWT>` -- obtained from the platform login endpoint |
| `x-org-id` | Organization ID -- scopes the request to a specific tenant |

> **Paths in this document are service-relative.** Every route is served through the
> Nginx gateway under the `/api` prefix, so the table entry `/pipelines/:id` is
> called as `https://<host>/api/pipelines/<id>` — as the `curl` examples below show.

Access tokens are **ES256, signed only by platform**, and carry a `kid` naming the signing key; every service verifies them against the key set at `GET /.well-known/jwks.json` (public, unauthenticated, cacheable). See [Authentication → how tokens are signed](authentication.md#how-tokens-are-signed-and-who-can-sign-one).

Access tokens are short-lived — **900 s (15 min) by default**, set by `JWT_EXPIRES_IN` with optional per-tier overrides via `JWT_EXPIRES_IN_<TIER>`. The short TTL is what makes privilege changes take effect quickly; see [Permissions → session invalidation](permissions.md#session-invalidation). Use the refresh-token endpoint to obtain a new access token without re-authenticating.

Routes marked **+ step-up** additionally require a short-lived step-up token in `X-Step-Up-Token`, earned from one of the platform's step-up endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/step-up` | Re-verify the account **password** → `{ stepUpToken, expiresAt }` |
| `POST` | `/auth/step-up/webauthn/options` + `/verify` | Re-verify with a **passkey**: `/options` returns `{ ceremonyId, options }`, `/verify` takes `{ ceremonyId, response }` → `{ stepUpToken, expiresAt, method: 'webauthn' }`. `409` when the account has no passkey |
| `POST` | `/auth/step-up/totp` | Re-verify with an **authenticator-app code**, `{ code }` → `{ stepUpToken, expiresAt, method: 'totp', via }`. A recovery code works here too (`via: 'recovery'`); `409` when the account has no authenticator, `429` when it is locked out after repeated wrong codes |
| `POST` | `/auth/step-up/reauth` | Start a **provider re-auth** (`{ type: 'oauth', provider }` or `{ type: 'sso', orgId }`) → `{ url, state }`; the only step-up an account with no password has |
| `POST` | `/auth/step-up/reauth/callback` | Exchange that flow's `{ code, state }` → `{ stepUpToken, expiresAt, method: 'reauth' }` |
| `POST` | `/auth/device/code` + `/auth/device/token` | The **CLI's** step-up: ask with `{ step_up: true }`, and the browser approval's own step-up is returned as `step_up_token` on the approved poll — so `pipeline-manager auth pat` needs no password |

`GET /user/profile` reports which factors the account has (`authFactors`: `hasPassword`, `passkeyCount`, `hasTotp`, `providers`). All of them share ONE per-user budget of 5 attempts/minute; TOTP adds a per-account lockout on top, because a 6-digit code is small enough that a request limiter alone is not the real bound. See **[Authentication → step-up](authentication.md#step-up-re-authentication-every-account)**.

### Internal routes are not part of this API

A handful of endpoints exist ONLY for service-to-service calls and are **closed
to every user token**, including a superadmin's: `/internal/*`, the quota usage
counters (`POST /quotas/:orgId/{increment,decrement}`), the entity-event ingest
(`POST /compliance/events/entity`), the audit ingest (`POST /audit/events`), the
org-onboarding hook (`POST /compliance/subscriptions/auto-subscribe`) and the
entitlement sync legs (`/compliance/entitlements/:orgId`,
`PUT /reports/retention-sync/:orgId`).

They require a token signed by one of a named set of internal services, so there
is no credential a client can hold that reaches them — a request with any user
token or access key gets `403 INSUFFICIENT_PERMISSIONS`. They are listed below
only so the surface is complete. See
[Authentication → internal routes](authentication.md#internal-routes).

---

## Endpoints

> **Every endpoint below is permission-gated.** Reads need the resource's
> `:read` permission and writes its `:write`/`:manage` (operator endpoints need
> the super-admin flag instead) — a Role that drops a `:read` is refused at the
> API, not just in the UI. Each service publishes its resolved route table
> (method, path, permissions, step-up, feature flag, audit action) and a test
> fails on any route that lacks its gate; see
> **[Permissions → route coverage](permissions.md#route-coverage)**.

The one exception is the public key set, which carries no tenant data and must
answer before any credential exists:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/.well-known/jwks.json` | The ES256 public keys user tokens are verified against. Unauthenticated, cacheable (10 min), served both at the root and under `/api`. Rotation adds a second `kid` for one overlap window. |

### Pipeline Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/pipelines` | List pipelines (filterable, paginated) |
| `GET` | `/pipelines/find` | Find one pipeline by query |
| `GET` | `/pipelines/:id` | Get by ID |
| `POST` | `/pipelines` | Create pipeline |
| `PUT` | `/pipelines/:id` | Update pipeline |
| `DELETE` | `/pipelines/:id` | Delete pipeline |
| `GET` | `/pipelines/providers` | List AI providers |
| `POST` | `/pipelines/generate` | AI-generate pipeline from prompt (consumes `aiCalls` quota) |
| `POST` | `/pipelines/generate/stream` | Stream AI generation as SSE (consumes `aiCalls` quota) |
| `POST` | `/pipelines/generate/from-url` | Analyze Git URL + generate pipeline as one JSON response — no plugin auto-creation; used by the Ask agent's `propose_pipeline_from_repo` (consumes `aiCalls` quota) |
| `POST` | `/pipelines/generate/from-url/stream` | Analyze Git URL + stream pipeline (consumes `aiCalls` quota) |
| `GET` | `/pipelines/registry` | List deployed-stack registrations (`pipelineId`, `stackName`, `region`, `lastDeployed`) for the caller's org — no ARNs, no account id |
| `POST` | `/pipelines/registry` | Upsert registry entry (deploy hook; tenant-guarded) |

### Plugin Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/plugins` | List plugins (filterable, paginated) |
| `GET` | `/plugins/find` | Find one plugin by query |
| `GET` | `/plugins/:id` | Get by ID |
| `POST` | `/plugins` | Upload plugin (ZIP multipart) |
| `POST` | `/plugins/lookup` | Find plugin by validated filter body (POST for URL-length safety) |
| `PUT` | `/plugins/:id` | Update plugin |
| `PUT` | `/plugins/bulk/update` | Bulk-update plugins (strict whitelist of mutable fields) |
| `DELETE` | `/plugins/:id` | Delete plugin |
| `GET` | `/plugins/providers` | List AI providers |
| `POST` | `/plugins/generate` | AI-generate plugin from prompt (consumes `aiCalls` quota) |
| `POST` | `/plugins/generate/stream` | Stream AI plugin generation as SSE (consumes `aiCalls` quota) |
| `POST` | `/plugins/deploy-generated` | Build and deploy AI-generated plugin |
| `GET` | `/plugins/plugin-usage` | Counts pipelines (in caller's org) referencing each plugin name |
| `GET` | `/plugins/queue/status` | Build queue counts (admin only) |
| `GET` | `/plugins/queue/failed` | Failed build jobs (org-scoped for non-system admins) |
| `GET` | `/plugins/queue/dlq` | Dead letter queue jobs (org-scoped for non-system admins) |
| `POST` | `/plugins/queue/dlq/:jobId/replay` | Replay a single DLQ job (admin only, tenant-checked) |
| `DELETE` | `/plugins/queue/dlq` | Purge all DLQ jobs (system admin only) |

### Compliance Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/compliance/scans` | Trigger a scan (caller-supplied `filter.orgId` is server-overwritten) |
| `POST` | `/compliance/exemptions` | Request an exemption |
| `POST` | `/compliance/exemptions/bulk` | Bulk-create up to 500 exemptions in one call |
| `PUT` | `/compliance/exemptions/:id/review` | Approve/reject an exemption (requester cannot self-approve) |
| `POST` | `/compliance/scan-schedules` | Create a cron-driven scan schedule (cron validated at insert time) |
| `POST` | `/compliance/validate/{plugin\|pipeline}` | Live compliance check (5s timeout, fail-closed) |
| `POST` | `/compliance/validate/{plugin\|pipeline}/dry-run` | Same evaluation, no audit/notify side-effects |
| `GET` | `/compliance/notification-preferences` | Read the org's notification preference (defaults when unset) |
| `PUT` | `/compliance/notification-preferences` | Update notification preference (org admin; webhook secret never returned) |

### Quota Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/quotas` | Caller's org quotas (plugins/pipelines/apiCalls/aiCalls) |
| `GET` | `/quotas/all` | All orgs' quotas (system admin only). `?limit=` 1–1000 (default 100) and `?offset=` 1-based, capped at 100 000 — deep paging past that is refused-by-clamp rather than turned into an unbounded collection scan |
| `GET` | `/quotas/at-risk?threshold=80` | Orgs ≥ threshold% on any quota dimension (system admin only) |
| `GET` | `/quotas/:orgId` | Specific org quotas (orgId in URL — auth scoped; the id is matched case-insensitively and canonicalized to lowercase for the lookup) |
| `GET` | `/quotas/:orgId/:type` | Single quota type status |
| `PUT` | `/quotas/:orgId` | Update tier/limits (system admin only) |
| `POST` | `/quotas/:orgId/reset` | Reset usage counters (system admin only; **+ step-up**, service principals exempt) |
| `POST` | `/quotas/:orgId/increment` | **Internal** (service-to-service only, no user token): increment usage (`amount` capped at 1000/call) |
| `POST` | `/quotas/:orgId/decrement` | **Internal** (service-to-service only, no user token): roll back a reserve |

**Pooled (account) limits and the `503` refusal.** For an org → team hierarchy the
binding cap is the ROOT's, counted against the whole subtree; a team's own limits
are seeded `-1` precisely because only the root's pooled cap is meant to apply.
So when the pooled cap cannot be resolved (a hierarchy read fails), the quota
service does NOT fall back to the team's own row — that would be unlimited, not
degraded. It serves the last-known root cap for up to
`QUOTA_POOL_FALLBACK_TTL_MS` (default 60s) and otherwise answers
`503 SERVICE_UNAVAILABLE` ("Quota is temporarily unenforceable for
organization …"), which reads and increments alike surface. A root or flat org
is unaffected: its own row carries real limits, so enforcement continues there.
Every such event increments `quota_pool_resolution_failed_total{quotaType,outcome}`
with `outcome` = `cached` | `denied` | `own_limits` — alert on `denied`.

### Message Service

Base path `/api/messages`. Reads require `messages:read`; writes require `messages:write` — except contacting support, which every member may do with `messages:read` (see below). Announcements (broadcast, `recipientOrgId: "*"`) are system-admin only.

| Method | Endpoint | Description | Permission |
|--------|----------|-------------|------------|
| `GET` | `/messages` | Inbox (root messages), paginated + viewer-scoped; `?search=` matches subject/content | `messages:read` |
| `GET` | `/messages/conversations` \| `/announcements` | Conversations / announcements views | `messages:read` |
| `GET` | `/messages/unread/count` | Unread count for the caller | `messages:read` |
| `GET` | `/messages/:id` \| `/:id/thread` | A message / its full thread (viewer-scoped) | `messages:read` |
| `POST` | `/messages` | Send a conversation or announcement | `messages:write` |
| `POST` | `/messages/support` | Contact support: a conversation to the support desk. Body is `subject`, `content`, optional `priority` / `attachmentIds` — **no recipient**: the server forces `recipientOrgId` to the system support org and `channel` to `support`, and ignores any `recipientOrgId` / `recipientUserId` / `messageType` / `channel` in the body | `messages:read` |
| `POST` | `/messages/:id/reply` | Reply to a thread | `messages:write` |
| `POST` | `/messages/attachments` | Upload one attachment (multipart `file`) → returns its id | `messages:write` |
| `GET` | `/messages/attachments/:id` | Download an attachment (auth-gated, inherits message visibility); `?thumb=1` serves the downscaled image thumbnail, falling back to the original | `messages:read` |
| `GET` | `/messages/:id/attachments` | List a message's attachment metadata | `messages:read` |
| `DELETE` \| `POST` | `/messages/:id[/restore]` | Soft-delete / restore (restore + step-up) | `messages:write` |

**Contacting support:** reaching support is self-service, so `POST /messages/support` is gated on `messages:read` — the same authority the inbox needs — rather than `messages:write`. A read-only member can therefore file a request although they cannot send ordinary messages. The route is safe at that floor because the recipient is not a caller input: it is always the system support org, on the reserved `support` channel. Everything else (validation, attachment linking, the SSE ping, the send rate limit) matches `POST /messages`; announcements, broadcasts and per-user targeting do not apply. Attachments must still be uploaded through `POST /messages/attachments`, which remains `messages:write`.

**Per-user direct messages:** a conversation `POST /messages` may include `recipientUserId` (a member of `recipientOrgId`) to target a single user — only that user (plus the sender org and system org) can see the message and its replies/attachments. Omit it for an org-wide message. `recipientUserId` is rejected on announcements/broadcasts.

**Attachments flow:** `POST /messages/attachments` first (one call per file, ≤ `MESSAGE_ATTACHMENT_MAX_MB`, MIME allow-listed), then pass the returned ids as `attachmentIds` on `POST /messages` or `/:id/reply`. Blobs live in S3-compatible storage (MinIO); see [Environment Variables → Messaging & Attachments](environment-variables.md#messaging--attachments).

### Organization & Access Service

Base path `/api/organization` (and `/api/invitation`). Management endpoints enforce **fine-grained permissions** via `requirePermission('resource:action')` — a user passes if their effective permissions (the union of the Roles assigned to them) include it, or they're a super-admin. The required permission is in the last column; endpoints marked *system admin* require the global super-admin flag instead.

| Method | Endpoint | Description | Permission |
|--------|----------|-------------|------------|
| `GET` | `/organization` | Caller's active organization | — (auth) |
| `POST` | `/organization` | Create an organization or nested team | `org:settings` |
| `GET` | `/organization/:id` | Get an organization, with a page of its member roster (`?membersLimit=` 1–500, default 100; `?membersOffset=`) — `memberCount` is always the full total. For a sysadmin it also carries the hierarchy: `parentOrgId`, `parentOrgName` and `teams: [{ orgId, orgName }]` (live teams) | — (own org / managed team / sysadmin) |
| `PUT` | `/organization/:id` | Update an organization's name, slug and/or description (+ step-up). The only route that edits the description | *system admin* |
| `DELETE` | `/organization/:id` | Soft-delete an organization (+ step-up): recovery snapshot, `purgeAfter` retention window, sessions cut → `202 { deletedAt, purgeAfter, snapshotId }`. The window is `max(ORG_DELETION_RETENTION_DAYS, SOFT_DELETE_RETENTION_DAYS)` — the org must outlive the rows its cascade tombstones. Refused (`400`) while it has live teams | *system admin* |
| `POST` | `/organization/:id/restore` | Restore a soft-deleted org inside its window (+ step-up). A parent admin may restore its own team; a team restore needs its parent live and still team-capable (`409`) and room in the account's pooled seats (`409`), and re-syncs the root's tier + entitlements | `org:settings` (own org / managed team) |
| `POST` | `/organization/:id/move` | Reparent (+ step-up). Body `{ parentOrgId: string \| null }`: a team to another eligible root (team/enterprise tier), a team out as a standalone root (`null`), or a root **with no teams** (live or pending deletion) in under a root. Refuses self-parenting, cycles, nesting two deep, an ineligible/missing destination and a no-op (`400`/`404`), a move over the destination's seat cap (`409`), a competing move that landed first (`409 ORG_MOVE_CONFLICT` — every structural check is re-asserted inside the transaction and the write is conditional on the parent this request read, so of two interleaved moves exactly one commits), and nesting a root that still has a billable subscription (`409`, cancel it first; `503` if billing can't confirm). Re-syncs tier, entitlements and quota seeding for the new account (a team takes the root's tier + entitlements with `-1` quotas; a new root starts on the default tier, since no subscription follows it, with that tier's quota preset and no entitlements) and invalidates every session scoped to the org → `{ organization }` (the detail DTO with hierarchy) | *system admin* |
| `PATCH` | `/organization/:id/tier` | Change pricing tier (+ step-up) | *system admin* |
| `GET` | `/organization/:id/export` | GDPR data export — a single JSON blob carrying every Postgres table and every Mongo collection the delete cascade removes (invitations, audit events, IdP config + group mappings, domains, join requests, SAML SLO sessions, service accounts + keys with the key hash stripped, memberships, Role assignments and Roles). The same artifact is captured as the recovery snapshot at soft-delete time; `failed` names any store that could not be read and `truncated` any that hit its cap | `org:settings` |
| `PATCH` | `/organization/:id/transfer-owner` | Transfer ownership (+ step-up on an `aal: 2` session) | `org:settings` |
| `GET` | `/organization/:id/members` | List members | — (member) |
| `GET` | `/organization/:id/members/:userId/exists` | Active-membership probe (`{ isMember }`) — internal, used by the message service to reject a per-user DM to a non-member | — (service / member) |
| `POST` \| `DELETE` \| `PATCH` | `/organization/:id/members[/:userId[/activate\|deactivate]]` | Add / remove / change-role / (de)activate a member | `members:manage` |
| `GET` | `/organization/:id/teams` | List live descendant teams (soft-deleted teams are excluded here, from `/:id/member/:memberId/teams` and from `/:id/descendants`) | — (member) |
| `GET` | `/organization/:id/teams/deleted` | Soft-deleted teams of `:id` still inside their retention window → `{ teams: [{ orgId, orgName, deletedAt, purgeAfter }] }`, newest first. Restore with `POST /organization/:teamId/restore` | `org:settings` (admin of `:id`) |
| `DELETE` | `/organization/:id/teams/:teamId` | A parent admin soft-deletes one of its own teams (+ step-up) — the same snapshot + retention window as the sysadmin delete → `202 { deletedAt, purgeAfter, snapshotId }`. `404` unless the team's direct parent is `:id`. The team leaves the live scope at once: its members stop counting against pooled seats and it drops out of team lists and rollups | `org:settings` (admin of `:id`) |
| `GET` | `/organization/:id/roles` | List Roles (permission sets) + members. Every Role without `?limit=`; with it (1–100, plus `?offset=`) one page, members loaded for that page only. Always returns `pagination.total` | — (member) |
| `POST` | `/organization/:id/roles` | Create a custom Role | `roles:manage` |
| `PUT` \| `DELETE` | `/organization/:id/roles/:roleId` | Update / delete a custom Role | `roles:manage` |
| `POST` \| `DELETE` | `/organization/:id/roles/:roleId/members[/:userId]` | Add / remove a Role member | `roles:manage` |
| `GET` | `/organization/:id/service-accounts[/:accountId]` | List (or read) the org's [service accounts](authentication.md#service-accounts) with their roles + key metadata — never a secret | `service_accounts:manage` |
| `POST` \| `PATCH` \| `DELETE` | `/organization/:id/service-accounts[/:accountId]` | Create / update (description, roles, token budget, disabled) / delete a service account. Delete removes every key with it | `service_accounts:manage` + step-up |
| `POST` | `/organization/:id/service-accounts/:accountId/keys` | Issue a `pb_sa_…` key — returned **once** (`{ key, accessKey }`); optional `ipAllowlist` and `scope` ([one capability instead of the account's Roles](authentication.md#scoped-keys--one-capability-no-roles): `reporting:ingest`, `registry:push`, `scim`), max 365 days, 5 active keys per account | `service_accounts:manage` + step-up |
| `DELETE` | `/organization/:id/service-accounts/:accountId/keys/:keyId` | Revoke one key — it stops working fleet-wide within 5 minutes. Deliberately **not** step-up gated, so a compromised key can be killed immediately | `service_accounts:manage` |
| `GET` \| `POST` | `/organization/:id/idp/group-mappings` | List / create an [IdP group → Role mapping](authentication.md#just-in-time-membership-and-group--role-mapping). SSO sign-in grants the mapped Roles (and creates the membership). Refused for a `google` config — Google issues no group claims | `roles:manage` (+ `sso` entitlement) |
| `PUT` \| `DELETE` | `/organization/:id/idp/group-mappings/:mappingId` | Update / delete a mapping. Roles it granted fall away at each member's next sign-in; Roles assigned by hand are never removed | `roles:manage` (+ `sso` entitlement) |
| `GET` \| `PUT` \| `PATCH` \| `DELETE` | `/organization/:id/idp` | Read / upsert / patch / remove the org's own SSO connection — **OIDC or SAML**, selected by `protocol`. A write that leaves the selected protocol unable to sign anyone in is refused (`400`). The client secret is write-only; the SAML entity ID, SSO/SLO URLs, signing certificates, attribute mapping and the `samlSignAuthnRequests` / `samlEncryptAssertions` switches are returned in full (all public), with `ssoRequired` and the `lastTest` result. `allowedEmailDomains` must be DNS-verified domains of the org (`400 IDP_DOMAIN_NOT_VERIFIED`). `PATCH { ssoRequired: true }` needs an enabled connection, a verified domain and a successful test of the current settings (`409`); any connection change clears `lastTest`. Writes require an MFA-grade session and a step-up earned by a **passkey or authenticator code** | `org:idp` (+ `sso` entitlement) |
| `GET` | `/organization/:id/idp/sp-info` | The values to register AT the IdP, computed from the deployment's public URL and SP keys: `{ sp: { entityId, acsUrl, metadataUrl, sloUrl, oidcRedirectUri, signingCertificate, encryptionCertificate } }`. Available before any connection exists | `org:idp` (+ `sso` entitlement) |
| `POST` | `/organization/:id/idp/metadata/import` | Parse an IdP SAML metadata document — `{ xml }` or `{ url }` (fetched under the SSRF guard: https, no private addresses, no redirects, 5 s, 512 KB) — into `{ metadata: { entityId, ssoUrl, sloUrl?, certificates, wantsSignedRequests } }`. Saves nothing | `org:idp` (+ `sso` entitlement) |
| `POST` | `/organization/:id/idp/test` | Start a **test connection** (dry run) → `{ url, state }` for a popup. Works before the connection is enabled | `org:idp` (+ `sso` entitlement) |
| `POST` | `/organization/:id/idp/test/complete` | `{ state, code?, error? }` → `{ report }`: ok / reason, asserted email / name / groups, the role mappings that would apply. Creates no session, user or membership; only the admin who started the test can collect it. Recorded as `lastTest` and audited `sso.test` | `org:idp` (+ `sso` entitlement) |
| `GET` \| `PATCH` | `/organization/:id/mfa-policy` | Read / change the org's [two-factor requirement](authentication.md#assurance-levels-and-required-mfa): `requireMfa`, a `graceDays` count the deadline is computed from server-side (0–90, default 14), and `idpEnforcesMfa` — the org's statement that its own IdP requires a second factor, which is what makes an SSO sign-in count as `aal: 2`. Enforced when a token is ISSUED, not per route: past the grace period a single-factor session is refused with `401 MFA_REQUIRED`. The read returns both the org's own setting and what a parent org imposes (`inheritedFrom` + `inheritedFromName`, the parent's id and name, when a parent's requirement applies), plus `enrolment: { members, enrolled }` — how many ACTIVE members hold a passkey or a confirmed authenticator app, so an admin choosing a grace period can see how many people it would refuse (someone holding both factors counts once). Also `adminActionsRequireMfa` — the separate ["administrative actions require MFA"](authentication.md#administrative-actions-require-mfa) policy (read returns `adminActionsRequireMfa`, `adminActionsOwn`, `adminActionsInheritedFrom[Name]`); turning it ON signs every other member of the org and its teams out so the `org_admin_aal` claim applies at once, while turning it off lets each token pick it up at its next refresh (`sessionsRefreshed` in the response). The write is step-up gated; LOOSENING anything (requirement off, admin-actions policy off, `idpEnforcesMfa` on) also needs an `aal: 2` session (`401 MFA_REQUIRED` otherwise), while tightening does not. Refused (`409 MFA_BOOTSTRAP_STILL_OPEN`) for the system org while the bootstrap-admin exception is still open | `org:settings` |
| `GET` \| `POST` | `/organization/:id/mfa-resets` | [Two-person MFA reset](authentication.md#recovery-when-every-factor-is-lost). GET lists pending (first) and recent requests for the org and its teams. POST `{ userId, reason }` requests a reset of an active member's second factors (owner/admin; `aal: 2` + step-up). `409 MFA_RESET_SELF` / `MFA_RESET_ALREADY_PENDING`, `403 MFA_RESET_PLATFORM_ADMIN`, `404 MFA_RESET_NOT_MEMBER` | `members:manage` |
| `POST` | `/organization/:id/mfa-resets/:requestId/approve` | Approve, `{ graceHours? }` (1–168, default 72): removes every passkey, the authenticator app and the recovery codes, ends every session, and grants the member a per-user enrolment grace. A DIFFERENT owner/admin of the org or an ancestor, or a sysadmin (`403 MFA_RESET_SECOND_PERSON_REQUIRED` for the requester or the member); `410 MFA_RESET_EXPIRED` after 24h. `aal: 2` + second-factor step-up | `members:manage` |
| `POST` | `/organization/:id/mfa-resets/:requestId/deny` | Deny (or, by its requester, withdraw), `{ note? }`. No step-up — it only removes a pending action | `members:manage` |
| `POST` | `/admin/users/:id/mfa-reset` | A sysadmin's DIRECT MFA reset, `{ reason, graceHours? }` — the single-person path for an org with no second admin; same effect as an approved request, audited as `auth.mfa.direct_reset`. `aal: 2` + second-factor step-up | sysadmin |
| `GET` \| `PATCH` | `/organization/:id/impersonation-policy` | Read / change whether platform operators may view as this org's members (`open`, `consent`, `denied`) and `allowSelfApproval`. Returns the EFFECTIVE policy (strictest across the org and its ancestors) with the org's `own` setting; when a parent's stricter policy applies, `inheritedFrom` + `inheritedFromName` name it. The write is step-up gated | `org:impersonation` |

#### SCIM 2.0 (`/api/scim/v2`)

Base path `/api/scim/v2` — driven by the customer's **identity provider**, not by
the dashboard. Authenticated ONLY by a service-account key carrying the `scim`
scope (`Authorization: Bearer pb_sa_…`); a user token is refused. No org id
appears in any path: the org is the key's own. Media type
`application/scim+json`; failures are RFC 7644 `…:2.0:Error` documents with a
string `status` and, where the RFC defines one, a `scimType`. Rate-limited per
organization in its own bucket. Full behaviour — seats, verified domains, session
revocation, the post-downgrade asymmetry — in
**[SCIM 2.0 provisioning](authentication.md#scim-20-provisioning)**.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/scim/v2/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | Discovery documents (what a validator fetches first) |
| `GET` | `/scim/v2/Users` | List members. `filter` supports `userName eq`, `externalId eq`, `active eq`, `emails.value eq`; pages with `startIndex` (1-based) + `count` (default 100, max 200) |
| `POST` | `/scim/v2/Users` | Provision a member. `409 uniqueness` if already a member; `400 invalidValue` at an unverified email domain; `403` naming the **seat limit** when the account is full |
| `GET` \| `PUT` \| `PATCH` | `/scim/v2/Users/:id` | Read / replace / patch. `active:false` deactivates the membership, drops the roles the directory granted, and **revokes every session immediately**. `userName` is write-once (`400 mutability`) |
| `DELETE` | `/scim/v2/Users/:id` | Deactivate + revoke sessions (the membership row is kept). Idempotent; `204` |
| `GET` | `/scim/v2/Groups` | List directory groups (the group → Role mapping rows). `filter`: `displayName eq`, `externalId eq` |
| `POST` \| `PUT` \| `PATCH` | `/scim/v2/Groups[/:id]` | Create / replace / patch a group and its **members**. SCIM never sets a group's **roles** — that stays a `roles:manage` decision in the dashboard |
| `DELETE` | `/scim/v2/Groups/:id` | Remove the group; its members lose the roles it mapped to (hand-granted roles stay). `204` |
| `POST` | `/invitation/send` | Send an invitation | `invitations:manage` |
| `GET` | `/invitation` | List invitations | `invitations:manage` |
| `DELETE` \| `POST` | `/invitation/:id[/resend]` | Revoke / resend an invitation | `invitations:manage` |

The full permission catalog (`pipelines:write`, `pipelines:publish`, `plugins:publish`, `compliance:write`, `billing:manage`, `reports:rollup`, `org:settings`, …) lives in `@pipeline-builder/api-core` (`types/permissions.ts`). Custom Roles grant a subset of the **org-assignable** permissions (`registry:read/write` are Super-Admin-only and rejected) that is also bounded by the **author's own permissions** (a permission ceiling — you can't grant what you don't hold); a member's effective permissions are the union of the Roles assigned to them, and `:read` permissions are enforced. Managing Roles is gated by `roles:manage`. See **[Roles & Permissions](permissions.md)** for the full catalog, built-in bundles, and enforcement.

### Account & Sessions

Base path `/api/user` (and `/api/auth`). These are the caller's **own** account —
no capability applies; a few writes require a step-up token (`X-Step-Up-Token`,
from `POST /auth/step-up`).

| Method | Endpoint | Description | Gate |
|--------|----------|-------------|------|
| `POST` | `/auth/sso/discover` | Login-page hint: `{ email }` → `{ sso: boolean, required: boolean }` — does an enabled, entitled IdP serve the domain, and does its org require SSO. Deliberately reports nothing else (not the owner break-glass exemption either) — it is unauthenticated, so returning the org id or provider would make it a tenant-enumeration oracle. Answers on the DOMAIN, so an address with no account looks identical to one with; a bootstrap-admin address always answers `false` (SSO refuses superadmins, and hiding their password field would close both paths) | — (pre-auth) |
| `POST` | `/auth/sso/start` | Start per-org SSO from an EMAIL: `{ email }` → `{ url, state }`, the same pair the by-org route returns. For the sign-in form, which knows the address and not the tenant — the serving org is resolved server-side, so discovery never has to hand out an org id. Works whether the org requires SSO or only offers it. `404 SSO_NOT_AVAILABLE` when no enabled, entitled IdP serves the domain | — (pre-auth) |
| `POST` | `/auth/sso/logout` | SP-initiated **SAML single logout** for the caller's OWN current session → `{ redirectUrl }`: a signed LogoutRequest to the IdP's SLO URL when the session came from a SAML sign-in and the IdP has one, else `null`. Call before `/auth/logout`, follow after | — (auth) |
| `GET` | `/auth/sso/:orgId/authorize` | Start per-org SSO → `{ url, state }`. Serves **both protocols**: the org's `protocol` decides whether `url` is an OIDC authorization request or a SAML `AuthnRequest`, and the caller just redirects to it | — (pre-auth; enabled + `sso`-entitled) |
| `POST` | `/auth/sso/:orgId/callback` | **OIDC** leg: `{ code, state }` → the same `{ accessToken }` + refresh cookie password login returns | the IdP's code + the state |
| `GET` | `/auth/sso/:orgId/saml/metadata` | **SAML** service-provider metadata (XML) for the IdP administrator: entity ID, ACS URL (HTTP-POST), SLO URL (HTTP-Redirect + HTTP-POST), `WantAssertionsSigned`, `AuthnRequestsSigned` per the org's switch, the SP signing certificate and — only when the org enabled encrypted assertions — the encryption certificate. Works before the connection does and leaks nothing | — (public) |
| `GET` \| `POST` | `/auth/sso/:orgId/saml/slo` | **SAML single logout** endpoint (HTTP-Redirect / HTTP-POST). A signed IdP **LogoutRequest** revokes that NameID's sessions in the org (in bounded batches, at most 1000 per request — the rest lapse with their refresh window and the cap is recorded on the audit event) and is answered with a signed LogoutResponse; a signed **LogoutResponse** to ours lands the browser on sign-in. Unsigned, forged, replayed or foreign-issuer messages are refused | the IdP's signature |
| `POST` | `/auth/sso/:orgId/saml/acs` | **SAML** Assertion Consumer Service — the IdP posts `SAMLResponse` + `RelayState` here. Verifies the signature, issuer, audience and validity window, refuses IdP-initiated and replayed assertions, provisions JIT membership, then **redirects** to `/auth/sso/:orgId/saml` with a one-time `handoff` (or an `error` code). Never returns tokens | the assertion + the RelayState |
| `POST` | `/auth/sso/:orgId/saml/complete` | Redeem that handoff, `{ handoff }` → the same `{ accessToken }` + refresh cookie password login returns. Single-use and org-bound; the session is minted **here**, so it records the redeeming browser | the handoff itself |
| `POST` | `/auth/refresh` | Rotate an **interactive** session's token pair. The browser presents the `pb_refresh` cookie (empty body); a CLI caller posts `{ refreshToken }`. Machine sessions are refused (they renew through `/user/generate-token`) | refresh cookie **or** body token, + `X-Pb-Client` |
| `POST` | `/auth/logout` | End the current session's slot and clear the refresh cookie | — (auth), + `X-Pb-Client` |
| `POST` | `/auth/switch-org` | Re-scope the current session to `{ organizationId }` (same slot, same assurance). Allowed with a membership there **or** admin authority inherited from a parent org — a parent admin can open its teams as `admin` with no roster entry (see [Authentication → parent-admin access](authentication.md#switching-organizations-and-parent-admin-access-to-teams)). `403` otherwise | — (auth) |
| `GET` | `/user/organizations` | Orgs the caller can switch into: membership rows (`organizationId`, `organizationName`, `slug`, `role`, `isActive`, `joinedAt`, `parentOrgId`, `parentOrgName`, `tier`, `childOrgCount`), then one `viaAncestor: true` row (`role: 'admin'`) per live team of an org they administer but aren't a member of | — (auth) |
| `POST` | `/user/generate-token` | Mint a stored **machine** credential (`{ expiresIn?, scope? }`, max 365 d). From a person: opens a new machine session with that scope. From a machine token: renews that session in place under its stored scope. Returns `{ accessToken, expiresIn }` — no refresh token | — (auth) |
| `GET` | `/user/tokens` | The caller's token-issuance history, newest first: `{ tokens: [{ id, createdAt, expiresAt, status }] }` where `status` is `active`, `expired`, or `revoked` (a later sign-out-everywhere) | — (auth) |
| `GET` | `/user/sessions` | Signed-in devices (`sessions`) and stored machine credentials (`machineSessions`), each with client summary, last IP, `amr`, scope, created / last-used; the caller's own session is flagged `current` | — (auth) |
| `DELETE` | `/user/sessions/:id` | Revoke one session — a device is signed out, a machine credential stops renewing. The current session is refused (use logout) | + step-up |
| `POST` | `/user/tokens/revoke-all` | Sign out everywhere: bump `tokenVersion`, clear every slot of both kinds, revoke the user's access keys | + step-up |
| `POST` \| `GET` \| `DELETE` | `/user/keys[/:id]` | Create / list / revoke an [access key](authentication.md#access-keys-opaque-verified-by-exchange). Create returns the raw `pb_pat_…` key **once** (`{ key, accessKey }`); the listing only ever shows `pb_pat_…last4`, plus scope, expiry, last use, where it was created, and the never-used / expiring-soon flags | create: + step-up |
| `POST` | `/auth/key/rotate` | [Self-rotation](authentication.md#self-rotation--how-an-unattended-machine-replaces-its-own-key) for unattended machines: mint a **sibling** `pb_sa_…` key on the presented key's account (`{ key, name?, expiresIn? }` → `{ key, keyId, previousKeyId, expiresAt, scope, prunedKeyIds }`), inheriting its scope, IP allowlist and lifetime. The presented key stays **live** — retire it afterwards. Pre-auth; same gates and limiters as the exchange; `pb_pat_…` keys refused | the key itself |
| `POST` | `/auth/key/revoke` | Retire a **sibling** key (`{ key, keyId }`) with the live key that replaced it. Revoking the presented key is refused (`400 SELF_REVOKE_REFUSED`) so a rotator cannot destroy its own credential; revoking an already-revoked key is idempotent success | the key itself |
| `POST` | `/auth/token/exchange` | Trade an access key (`{ key }`) — a person's `pb_pat_…` or a service account's `pb_sa_…` — for a 5-minute `token_use: api_key` JWT (`{ accessToken, expiresIn, keyId }`). Pre-auth — the key is the credential. A service-account key additionally checks the account is enabled, its org live, the presenting address within the key's IP allowlist, and its own exchange budget. Rate-limited per key and per IP; every outcome audited, and every refusal answers the same 401 | the key itself |
| `POST` | `/auth/device/code` | Open a **device authorization** (RFC 8628). Body `{ step_up?: true }`. Returns the RFC shape: `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`. Pre-auth — the caller has no identity yet | — (rate-limited per IP) |
| `POST` | `/auth/device/token` | The waiting device's poll, `{ device_code }`. Answers `{ access_token, refresh_token, token_type, expires_in }` (plus `step_up_token` when the flow asked for one) once approved, else HTTP 400 with the RFC's `{ error }`: `authorization_pending`, `slow_down` (with a widened `interval`), `access_denied`, `expired_token`. Single-use | the device code itself |
| `GET` | `/auth/device/authorize?user_code=…` | What the signed-in user is being asked to approve: `{ request: { userCode, client, ip, requestedAt, expiresAt, stepUpRequested } }` — never the device code. `404` unrecognised, `410` expired, `409` already decided | — (auth, per-user limit) |
| `POST` | `/auth/device/approve` | Grant the waiting device a session, `{ userCode }`. The CLI session inherits this session's org, `amr`, `aal` and `auth_time` | + step-up |
| `POST` | `/auth/device/deny` | Refuse the waiting device, `{ userCode }`. Its next poll gets `access_denied` | — (auth) |
| `POST` | `/auth/webauthn/register/options` | Begin enrolling a **passkey** → `{ ceremonyId, options }` (`residentKey: required`, `userVerification: required`, existing credentials in `excludeCredentials`) | + step-up, interactive session |
| `POST` | `/auth/webauthn/register/verify` | Store it: `{ ceremonyId, response, name }` → `{ passkey, recoveryCodes? }` — the account's recovery codes ride along, once, when this passkey is its FIRST second factor. `409` when that authenticator is already registered. Not step-up gated again — the ceremony it consumes was minted by the gated call, bound to the user and single-use | — (auth), interactive session |
| `GET` | `/auth/webauthn/credentials` | The caller's passkeys: name, added, last used, synced flag. Never the public key | — (auth) |
| `PATCH` | `/auth/webauthn/credentials/:id` | Relabel one, `{ name }` (≤ 64 chars) | — (auth), interactive session |
| `DELETE` | `/auth/webauthn/credentials/:id` | Revoke one. `409 LAST_SIGN_IN_METHOD` when it is the account's only way in (no password, no linked provider, no other passkey) | + step-up, interactive session |
| `POST` | `/auth/webauthn/login/options` | A **sign-in** challenge for a discoverable credential → `{ ceremonyId, options }`. Public, names no user, and has its own per-IP limiter (browser autofill asks on every page load) | — (pre-auth) |
| `POST` | `/auth/webauthn/login/verify` | Sign in, `{ ceremonyId, response }` → the same `{ accessToken }` + refresh cookie password login returns. Every failure answers one opaque `401`, except an SSO-enforced account, which gets the same `403 SSO_REQUIRED` password login gives (the assertion already proved who the caller is) | the assertion itself |
| `GET` | `/auth/totp/status` | Whether the caller has an **authenticator app**: `{ enabled, pending, activatedAt, lastUsedAt, recoveryCodesRemaining, recoveryCodesTotal, recoveryGeneratedAt, lockedUntil }`. Never the secret | — (auth) |
| `POST` | `/auth/totp/enrol` | Mint a secret → `{ secret, otpauthUri }` (SHA-1 / 6 digits / 30 s — fixed, for authenticator compatibility). The secret is returned **once** and stored encrypted at rest, HKDF-bound to the user. `409` when an enrolment is already active (disable first), `403` when the address is SSO-enforced — the org's IdP owns its factors | + step-up, interactive session |
| `POST` | `/auth/totp/activate` | Confirm it with a code, `{ code }` → `{ recoveryCodes }` — the account's ten recovery codes, shown **once** and stored only as hashes, when this is its FIRST second factor; an empty list when a passkey already minted the set. Not step-up gated again — it confirms the secret the gated call minted, and the code is the proof | — (auth), interactive session |
| `DELETE` | `/auth/totp` | Turn it off — taking the recovery codes with it when no passkey remains. `409` when it would leave no way to sign in | + step-up, interactive session |
| `GET` \| `POST` | `/auth/recovery-codes` | The account's [recovery codes](authentication.md#recovery-codes) — ONE set, shared by passkeys and the authenticator app. GET → `{ recoveryCodes: { remaining, total, generatedAt } }`; POST replaces the whole set → `{ recoveryCodes }` (every previous code stops working; `409 RECOVERY_CODES_NO_FACTOR` without a second factor) | POST: + step-up, interactive session |
| `POST` | `/auth/mfa/verify` | Second leg of a password sign-in, `{ challengeId, code }` → the same `{ accessToken }` + refresh cookie password login returns, with `mfa` added to `amr`. A recovery code works here too. A WRONG code does not burn the challenge (a typo must not cost a password entry); a correct one spends it, so one handle yields at most one session. Every failure answers one opaque `401`, except an unknown or spent challenge (`401 TOTP_INVALID_CHALLENGE`, so the sign-in page can send the person back to the password field) | the challenge + the code |

Access tokens carry an explicit identity — `principalType`, `token_use`, `amr`,
`aal`, `auth_time` — which services enforce; see
[Authentication → Token claims](authentication.md#token-claims-what-a-request-proves).

**`X-Pb-Client`** names the calling client on every request: `web` (the browser
app) receives its refresh token as an `HttpOnly` cookie and never in the body,
any other value keeps the JSON body flow. `/auth/refresh` and `/auth/logout`
reject a request that omits the header with `403 CLIENT_TYPE_REQUIRED` — it is
the CSRF proof that makes the ambient cookie safe. Every session-issuing
endpoint (login, OAuth/SSO callback, `switch-org`, `tokens/revoke-all`) applies
the same split. See
[Authentication → Where the refresh token lives](authentication.md#where-the-refresh-token-lives).

### Common Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | `10` | Page size (1-`MAX_PAGE_LIMIT`, default cap 1000) |
| `offset` | int | `0` | Records to skip |
| `sortBy` | string | `createdAt` | Sort field |
| `sortOrder` | `asc`/`desc` | `desc` | Sort direction |
| `visibility` | `private`/`org`/`public` | — | Narrow to one sharing rung (within what you can already see) |
| `isActive` | boolean | — | Filter by active status |
| `isDefault` | boolean | — | Filter by default status |

---

## Examples

### Plugins

**Upload:**

```bash
curl -X POST https://localhost:8443/api/plugins \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-org-id: $ORG_ID" \
  -F "plugin=@./my-plugin.zip" \
  -F "visibility=private"
```

**List / Find:**

```bash
curl "https://localhost:8443/api/plugins?name=node-build&limit=10" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"

curl "https://localhost:8443/api/plugins/find?name=node-build&version=1.0.0" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"
```

**Update:**

```bash
curl -X PUT "https://localhost:8443/api/plugins/<id>" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{"description": "Updated plugin", "computeType": "LARGE", "isDefault": true}'
```

**Delete:**

```bash
curl -X DELETE "https://localhost:8443/api/plugins/<id>" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"
```

### Pipelines

**Create:**

```bash
curl -X POST https://localhost:8443/api/pipelines \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "my-app",
    "organization": "my-org",
    "pipelineName": "my-app-pipeline",
    "visibility": "private",
    "props": {
      "project": "my-app",
      "organization": "my-org",
      "synth": {
        "source": {
          "type": "github",
          "options": { "repo": "my-org/my-app", "branch": "main" }
        },
        "plugin": { "name": "cdk-synth", "version": "1.0.0" }
      }
    }
  }'
```

**List / Find:**

```bash
curl "https://localhost:8443/api/pipelines?project=my-app&limit=10" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"

curl "https://localhost:8443/api/pipelines/find?project=my-app&organization=my-org" \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID"
```

### AI Generation

**Generate pipeline:**

```bash
curl -X POST https://localhost:8443/api/pipelines/generate \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Build a Node.js app from GitHub, run tests, and deploy with CDK",
    "provider": "anthropic",
    "model": "claude-sonnet-5"
  }'
```

**Generate + deploy plugin:**

```bash
# Step 1: Generate
curl -X POST https://localhost:8443/api/plugins/generate \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A Node.js 20 build plugin that runs npm ci, npm test, and npm run build",
    "provider": "anthropic",
    "model": "claude-sonnet-5"
  }'

# Step 2: Deploy (review/edit the generated output, then submit)
curl -X POST https://localhost:8443/api/plugins/deploy-generated \
  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "nodejs-build",
    "version": "1.0.0",
    "commands": ["npm run build"],
    "installCommands": ["npm ci"],
    "dockerfile": "FROM node:20-slim\n..."
  }'
```

---

## Response Format

All API responses follow a consistent format:

**Success:**
```json
{
  "success": true,
  "statusCode": 200,
  "data": { ... }
}
```

**Paginated:** list endpoints return their items under a named key (`pipelines`, `plugins`, `registry`, etc.) alongside a `pagination` object:
```json
{
  "success": true,
  "statusCode": 200,
  "pipelines": [ ... ],
  "pagination": {
    "total": 42,
    "limit": 10,
    "offset": 0,
    "hasMore": true
  }
}
```

**Error:** the error `code` and `message` are returned at the top level (not nested), with an optional `details` field:
```json
{
  "success": false,
  "statusCode": 404,
  "code": "NOT_FOUND",
  "message": "Pipeline not found"
}
```

---

## Reporting Endpoints

Pipeline execution and plugin build analytics. Time ranges default to the last 30 days. See [AWS Deployment -- Report API Endpoints](aws-deployment.md#report-api-endpoints) for the full endpoint list with query parameters.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/reports/execution/count` | Execution count per pipeline with status breakdown |
| `GET` | `/reports/execution/success-rate` | Pass/fail rate over time |
| `GET` | `/reports/execution/duration` | Avg/min/max/p95 execution duration |
| `GET` | `/reports/execution/stage-failures` | Stage failure heatmap |
| `GET` | `/reports/execution/stage-bottlenecks` | Slowest stages per pipeline |
| `GET` | `/reports/execution/errors` | Error categorization (top N) |
| `GET` | `/reports/execution/dora` | **Per-environment** DORA metrics (headline `production`) with performance-level bands: deploy-basis frequency, **measured** lead time (commit→deploy; `unknown` when unresolved — no proxy), two-class change-failure rate, production MTTR, coverage (`reports:read` **+ `advanced_reporting` feature** — Enterprise, or the Advanced Reporting add-on; `from`, `to`, `includeDescendants` needs `reports:rollup`; optional `pipelineId`, `environment`). See [DORA Metrics](dora-metrics.md) |
| `GET` | `/reports/execution/dora/trend` | DORA deployment-frequency + change-failure trend bucketed by `interval` (same gates/scoping as `/dora`) |
| `GET` | `/reports/execution/build-health` | Per-pipeline **build health** — per-stage success rate + p50/p90/p99 timing (`reports:read`; **not** `advanced_reporting` — standard on every tier; `pipelineId`, `from`, `to`) |
| `POST` | `/reports/deployments/:executionId/outcome` | Mark a **successful** production deploy as `failed`/`restored` (feeds post-deploy CFR + real MTTR); `pipelines:write` **+ `advanced_reporting`** |
| `POST` | `/reports/incidents` | Ingest a production **incident** `{incidentId, environment, openedAt, resolvedAt?, severity}` from your monitoring → automated post-deploy CFR/MTTR. Machine **`reporting:ingest`** scope, idempotent on `(org, incidentId)`. See [Incident Webhook](incidents-webhook.md) |
| `POST` | `/reports/ingest-health` | The ingestion Lambda's delivery-health heartbeat `{forwarded, dropped, lastEventAt}`. Machine **`reporting:ingest`** scope |
| `GET` | `/reports/ingest-health` | Read that heartbeat back — `{health, now}`, where `health` is `null` when the deployment has **never** reported ingestion (not the same as stale) and `now` is the server clock. Drives the Reports freshness strip, which separates "no deploys in range" from "nothing has reached the ingest pipeline since X". User-facing: org-scoped, `reports:read` (**not** the `reporting:ingest` scope, and **not** `advanced_reporting` — it applies to the execution reports every tier sees) |
| `GET` | `/reports/retention` | The org's **effective** retention, read-only — `{eventRetentionDays, doraRetentionDays, eventMaxRangeDays, doraMaxRangeDays}` (`-1` = unlimited; `*MaxRangeDays` is the horizon clamped to the 730-day report ceiling). Drives the Reports date-range cap. `reports:read` only (**not** `advanced_reporting` — the Retention Pack is sold to every tier) |
| `GET` | `/reports/plugins/summary` | Plugin inventory stats |
| `GET` | `/reports/plugins/build-success-rate` | Docker build success rate over time |
| `GET` | `/reports/plugins/build-duration` | Build time per plugin |
| `GET` | `/reports/plugins/build-failures` | Build failure reasons (top N) |
