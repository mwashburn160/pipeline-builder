---
layout: default
title: Audit Events
image: /assets/og-image-audit.png
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Audit Events

A **tamper-evident audit trail** in the `platform` service's MongoDB `audit_events` collection.

## Highlights

- **Ordering is by sequence, not clock.** A UNIQUE `(affectedOrgId, seq)` index is the cross-replica compare-and-set, so concurrent writers can never fork a chain.
- **The chain key is never in the database.** Someone with write access to Mongo but not `AUDIT_CHAIN_HMAC_KEY` cannot re-chain around an edited, inserted or deleted row.
- **Published heads catch tail truncation.** Deleting the newest rows and rewinding the in-DB head leaves an internally consistent, shorter chain that only an external, Object-Locked anchor can contradict.
- **A service token cannot forge a platform event.** The ingest validates `action` against the `REMOTE_AUDIT_ACTIONS` allow-list, not the full union, so `admin.superadmin.grant` and `user.login` are out of reach.
- **A failed audit never fails the mutation.** Delivery is fire-and-forget, with a bounded Redis spool and a stable `Idempotency-Key`, so a retry collapses to one row and one chain link.
- **An AWS account id is never persisted.** Every event's `details` is scrubbed before hashing.
- **Verification is retention-aware**, so an org whose oldest rows have aged out under the TTL does not false-alarm.
- **Exactly one terminal outcome per plugin build** — a job that fails the tier queue but succeeds in the DLQ emits only `plugin.build.completed`.

## Overview

This reference explains how Pipeline Builder produces, secures and queries its audit trail, and catalogs every action it records. It is for compliance reviewers and operators.

It covers the emitter paths, the per-tenant HMAC hash-chain integrity model with write-once published heads, sensitive-data scrubbing, and the full [action catalog](#action-catalog) — platform-emitted lifecycle events plus the `REMOTE_AUDIT_ACTIONS` subset. The catalog stays in sync with the `AuditAction` union in code; see [Adding a new audit event](#adding-a-new-audit-event) to extend it.

## How it works

Two emitters feed the Mongo trail, and a separate structured-log path exists for the image registry.

| Path | Who | How |
|---|---|---|
| **Platform-direct** | the `platform` service | Writes user and org lifecycle events straight to Mongo via the `audit()` helper ([platform/src/helpers/audit.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/platform/src/helpers/audit.ts)) and `auditService.createEvent(...)` |
| **Service-remote** | every other service — pipeline, plugin, quota, compliance, image-registry, message, billing, reporting | POSTs to the platform ingest `POST /audit/events` through the shared `RemoteAuditClient` ([packages/api-core/src/services/remote-audit-client.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/services/remote-audit-client.ts)) |
| **Registry structured logs** | image-registry, additionally | Emits `eventCategory: 'audit'` log lines to Loki for a couple of registry operations — see [Registry structured-log events](#registry-structured-log-events) |

Both emitter paths funnel through **one appender** (`appendAuditEvent` in [platform/src/helpers/audit-chain.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/platform/src/helpers/audit-chain.ts)), so every stored event is hash-chained and scrubbed the same way.

Each stored record then carries:

1. the next per-chain `seq`, claimed through a unique index;
2. an HMAC digest over its canonical fields plus `seq` and `prevHash`;
3. scrubbed `details`, with AWS-account-shaped tokens redacted **before** hashing;
4. `actorId` / `actorEmail`, `orgId` (the actor's own org) and `affectedOrgId` (the org actually operated on).

`orgId` and `affectedOrgId` diverge when a sysadmin acts on another org, which is what lets the trail answer "what did a sysadmin do to org X?" — SOC2 evidence for impersonation-style access (see [Impersonation](permissions.md#impersonation-view-as-user)). `admin.*` actions and `admin.impersonate.start` set `affectedOrgId` to the target org so the affected org's own admins can see them.

## Configuration

1. **Set `AUDIT_CHAIN_HMAC_KEY`.** Platform refuses to boot in production without it. At least 32 characters — generate with `head -c 32 /dev/urandom | base64`. Treat it as the audit trail's signing key: rotating it invalidates verification of rows chained under the old key.
2. **Point the head export at a bucket with Object Lock.** Without it you have an internally consistent chain and no way to detect tail truncation. The bootstrap Job creates the bucket and verifies WORM behaviour with a live smoke test.
3. **Keep the head retention above the event retention.** `AUDIT_HEAD_EXPORT_RETENTION_DAYS` (default 400) must exceed `AUDIT_RETENTION_DAYS` (default 90), or heads age out before the rows they anchor.
4. **Configure Redis** if you cannot tolerate silent loss. Without it, a dropped platform-local event is only counted in `audit_local_dropped_total`.
5. **Watch the loss metrics**, not just the logs: `audit_emitted_total`, `audit_dropped_total`, `audit_events_rejected_total`, `audit_spool_{enqueued,dropped,redelivered}_total`.

| Env var | Meaning |
|---|---|
| `AUDIT_CHAIN_HMAC_KEY` | Chain HMAC key (required in production; never in the DB) |
| `AUDIT_RETENTION_DAYS` | TTL on stored events, default 90 |
| `AUDIT_HEAD_EXPORT_S3_ENDPOINT` | e.g. `http://rustfs:9000`; export disabled when unset |
| `AUDIT_HEAD_EXPORT_S3_BUCKET` | default `audit-heads` — created with Object Lock by the bootstrap Job, verified live at bootstrap by a WORM smoke test |
| `AUDIT_HEAD_EXPORT_S3_REGION` | default `us-east-1` |
| `AUDIT_HEAD_EXPORT_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | bucket-scoped credentials (PutObject + GetObject only) |
| `AUDIT_HEAD_EXPORT_PREFIX` | default `audit-heads` |
| `AUDIT_HEAD_EXPORT_LOCK_MODE` | `COMPLIANCE` (default), `GOVERNANCE`, or `none` for a target without Object Lock |
| `AUDIT_HEAD_EXPORT_RETENTION_DAYS` | object retention, default 400 (keep it above `AUDIT_RETENTION_DAYS`) |
| `AUDIT_HEAD_EXPORT_INTERVAL_MS` | export cadence, default 300000 |

### Reading the trail

Query via `GET /audit` — admin-only; org admins are forced to their own org, sysadmins may filter any org — or the dashboard **Audit** page at `/dashboard/audit`.

Filters: `action`, `actorId`, `impersonatorId`, `targetType`, `targetId`, `roleId`, `requestId`, `outcome`, `from` / `to`, and — sysadmin only — `orgId` and `affectedOrgId`. `requestId` and `impersonatorId` work for service-emitted events too: the remote-audit client stamps both from the request that caused the event (see [Auto-captured context](#auto-captured-context)), so one request id returns every row it produced, in every service. Every one is also a URL parameter of the Audit page, and the ids on each row narrow the list to that actor, impersonator, target or Role (`roleId` is the permission Role an `org.role.*` action touched).

Records auto-expire via a MongoDB TTL index after `config.audit.retentionDays` days.

## Integrity & tamper-evidence

Every event is linked into a **per-tenant HMAC hash chain** (chain key =
`affectedOrgId ?? orgId`):

- **Sequence, not clock.** Each event gets the next per-chain `seq`
  (`audit_chain_heads` holds each chain's `{ seq, hash }`; it has no TTL). A
  UNIQUE `(affectedOrgId, seq)` index is the cross-replica compare-and-set, so
  concurrent writers can never fork a chain, and ordering never depends on
  replica clocks.
- **Keyed digest.** `hash = HMAC-SHA256(AUDIT_CHAIN_HMAC_KEY, canonical fields +
  seq + prevHash)`. The key is an env / KMS-backed secret that is **never stored
  in the database** — someone with write access to Mongo but not the key cannot
  re-chain around an edited, inserted or deleted row. Platform refuses to boot in
  production without it (≥ 32 chars; generate with `head -c 32 /dev/urandom |
  base64`). Rotating it invalidates verification of rows chained under the old
  key — treat it like the audit trail's signing key.
- **Published heads (write-once).** Every `AUDIT_HEAD_EXPORT_INTERVAL_MS`
  (default 5 min) one platform replica publishes each advanced chain head —
  `{ chainKey, seq, hash, headCreatedAt, exportedAt }`, signed with the same key —
  to an S3-compatible bucket created **with Object Lock**:
  `<prefix>/<chainKey>/<seq>.json` plus `<prefix>/<chainKey>/latest.json`, each
  PUT carrying `x-amz-object-lock-mode` (`AUDIT_HEAD_EXPORT_LOCK_MODE`,
  default `COMPLIANCE`) and a retain-until date `AUDIT_HEAD_EXPORT_RETENTION_DAYS`
  (default 400) ahead. This is what exposes **tail truncation** — deleting the
  newest rows and rewinding the in-DB head leaves an internally consistent,
  shorter chain that only an external anchor can contradict.

- **Verify** — `GET /audit/verify?orgId=<id>` (`audit:read`) walks a tenant's
  chain in `seq` order and returns `{ ok, brokenAt?, reason?, count, lastSeq,
  unverifiable, publishedHead? }`. `reason` is one of `hash-mismatch` (a field
  was edited), `broken-link` / `sequence-gap` (a row was deleted or re-ordered),
  `tail-truncated` (the chain no longer reaches its in-DB or published head),
  `head-mismatch` (the row at the published `seq` has a different hash), or
  `published-head-invalid` (the stored head's signature fails). `publishedHead`
  reports `matched` / `absent` / `expired` / `pruned` / `unavailable`, and
  `stale: true` when the newest events aren't externally anchored yet. The
  dashboard **Audit** page surfaces this as a **Verify integrity** action.
- **Retention-aware** — verify anchors on the first *surviving* event, so an org
  older than the retention window (whose oldest rows have aged out under the
  TTL) does **not** false-alarm, and a head older than the retention window is
  not required to still exist. Truncation of the oldest contiguous prefix is
  indistinguishable from normal TTL pruning.
- **`occurredAt`** — events carry an `occurredAt` (when the action really
  happened), stored for reviewers. It is **not** the chain-ordering field — the
  chain orders by `seq` — so a delayed/spooled delivery never perturbs chain
  consistency or verification.
- **No silent loss on the platform side** — a platform-local write that fails
  (Mongo blip, failover) is spooled to Redis (`audit:spool:platform-local`) and
  re-appended by a background drain, with the same per-emission
  `Idempotency-Key` so a write that actually committed isn't doubled. Without
  Redis configured, a dropped event is counted in `audit_local_dropped_total`.

### Sensitive-data scrubbing

`appendAuditEvent` runs `scrubAwsIdentifiers()` over every event's `details`
before hashing and storing, redacting AWS-account-id-shaped tokens (including the
account segment of any ARN) and account-named keys. **An AWS account id is never
persisted** — `orgId` is the platform org id (a Marketplace customer is keyed on
its license ARN, in subscription metadata), never an AWS account id. Emitters must also keep secrets/tokens out of `details`; the frontend
applies a second redaction pass before rendering or exporting.

## Service-remote ingest (`POST /audit/events`)

Non-platform services emit with api-core's ONE call, `recordAudit(event)`. The
service identity is bound once at boot by `wireServiceSecurity(serviceName)`
(every service calls it), so no call site names its service; calling
`recordAudit` before that binding throws "audit not initialised" rather than
sending an unattributed event. Delivery goes through `RemoteAuditClient`, which
is best-effort and **fire-and-forget** — a failed audit never blocks or fails
the originating mutation. Three properties make it safe and durable:

- **Anti-forgery subset lock** — the ingest authenticates the caller as a service
  principal (`requireServiceAuth`) and validates `action` against the
  `REMOTE_AUDIT_ACTIONS` allow-list (`isRemoteAuditAction`), **not** the full
  platform `AuditAction` union. A service token therefore cannot forge
  platform-authority events (`admin.superadmin.grant`, `org.ownership.transfer`,
  `user.login`, …). A `REMOTE_AUDIT_ACTIONS ⊆ AuditAction` test guards drift.
- **Idempotent** — each emission carries a stable `Idempotency-Key`; the ingest
  dedups on it (unique **per org** — `(orgId, idempotencyKey)` — so one tenant
  can never pre-claim another's key), so a retried delivery collapses to a single
  stored row and a single chain link.
- **Durable spool** — if the platform is down past the client's retry budget, the
  event is buffered in a bounded Redis spool
  ([packages/api-core/src/services/audit-spool.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/services/audit-spool.ts))
  and re-delivered on recovery instead of being lost. The spool drops the OLDEST
  on overflow (with a metric) so it can never grow unbounded. A spooled event
  reuses its `Idempotency-Key`, so a live attempt and its later re-delivery
  dedup to one row.
- **4xx is permanent** — only a network error, a 5xx, `408` or `429` is retried
  and spooled. Any other 4xx is the ingest's verdict on the event itself (an
  unknown action, a cross-org event from a token that may not record one), so
  retrying can never succeed — and a spooled event that can never deliver used
  to sit at the head of the spool and stall every later event behind it. The
  client DROPS it, logs `Remote audit event REJECTED` at error with the action,
  org, target and request id, and counts `audit_events_rejected_total{service,status}`.
  The `AuditEventsRejected` alert pages on any increase: it is always a code bug.
- **`orgId` is required** — the ingest binds every event to the service token's
  org and the client mints that token with `event.orgId`, so `RemoteAuditEvent`
  makes `orgId` a required field. System work with no tenant passes
  `SYSTEM_ORG_ID` explicitly; an unauthenticated `authz.denied` is recorded on
  the system org.
- **Cross-org `affectedOrgId`** — accepted only when the VERIFIED token allows
  it, never the body: a sysadmin token; a token minted for the **system org**
  (ecosystem moderation of a publisher's plugin, registry work on a tenant's
  repository — record those with `orgId: SYSTEM_ORG_ID`); or a token carrying
  the signed `auditCrossOrg` claim. The client sets that claim only when the
  event's verified inbound principal was a superadmin or a system-org member
  (`_auth.superAdmin` / `_auth.systemOrg`) — an operator retrying or purging a
  tenant's resource. A tenant-scoped token without it is refused `403` and the
  refusal is itself an `authz.denied`.

### Auto-captured context

Every event carries the context of the request (or job) that caused it, with no
call-site code. api-server's request-id middleware opens an `AsyncLocalStorage`
audit scope per request (platform's does the same), and the remote-audit client
reads it when an event is RECORDED, stamping the values onto the event so a
spooled re-delivery keeps them.

| Field | Source |
|---|---|
| `requestId` | the inbound `X-Request-Id` when it is a bounded opaque token (≤128 chars of `[A-Za-z0-9._:/@+=-]`), else a fresh uuid; echoed on the response |
| `traceId` | the active OpenTelemetry span at request entry |
| `ip`, `userAgent` | `req.ip` (proxy-resolved), the User-Agent with control characters stripped, capped at 512. **Not** stamped on an `anonymous` actor's row from another service — those public surfaces (plugin submissions, report verify/unsubscribe) record only a hashed ip/address |
| `impersonatorId` | the inbound request's VERIFIED token — never a call-site field |
| `details._auth` | the verified credential: `principalType`, `service` (service tokens), `keyId` (`parentKeyId ?? jti` — the access key, impersonation session or service mint to revoke), `sid`, `scope`, `tokenUse`, `permissionsRestricted`, `superAdmin`, `systemOrg` |
| `details._context` | inbound correlation ids and the job identity (below) |

`_auth` and `_context` are **reserved**: whatever a call site puts under those
keys is replaced. They live in `details` so the hash chain covers them
(`details` is a hashed field). Platform's own `audit(req, …)` helper and the
`authz.denied` sink record the same `_auth` block, so the shape is identical
across emitters.

**Trust model.** The ingest accepts only service tokens, each signed by the
emitting service's own key. `impersonatorId` and `_auth` are accepted from that
service on the same basis as `actorId`: api-core fills them solely from the JWT
the service itself verified on the inbound request, and they are not settable
through `recordAudit`'s event type. The ingest still bounds every forwarded
field (`ip`, `traceId`, `requestId`, `impersonatorId` must match their formats;
a malformed value is dropped, not stored).

**Correlation headers.** A caller outside a browser session — the CLI, a Lambda,
a CodeBuild step — can make its calls traceable by sending:

| Header | Recorded as |
|---|---|
| `X-Request-Id` | `requestId` |
| `X-Pipeline-Execution-Id` | `details._context.pipelineExecutionId` |
| `X-CodeBuild-Build-Id` | `details._context.codebuildBuildId` |
| `X-Source-Event-Id` | `details._context.sourceEventId` |

Each is validated like `X-Request-Id` (an invalid value is dropped, never
truncated). No AWS account id is stored: an ARN has its account segment emptied
and a bare 12-digit value is refused.

**Background jobs.** Work outside a request opens its own scope:

```ts
import { runWithAuditContext } from '@pipeline-builder/api-core';

await runWithAuditContext({ job: { jobId: 'registry-gc', runId, trigger: 'schedule' } }, () => sweep());
```

Every `recordAudit` inside lands with `details._context = { jobId, runId, trigger }`.
Nested scopes merge, so a job started inside a request keeps the request's id.

**Observability** — audit loss is metered, not just logged:
`audit_emitted_total`, `audit_dropped_total`, `audit_events_rejected_total`,
`audit_spool_{enqueued,dropped,redelivered}_total`.

## Querying the trail

**From the UI**, two admin surfaces read the MongoDB audit trail, both scoped
the same way: an **org admin** sees events where their org was the actor's org
(`orgId`) or the affected org (`affectedOrgId`); a **system admin** sees every
org; plain members see neither.

- **Audit Log** (`/dashboard/audit`) — the searchable, paginated list with the
  integrity (`/audit/verify`) check.
- **Audit Activity** dashboard (`/dashboard/observability/audit-activity`) —
  events over time by type, top actors (24h), and recent events. Its catalog
  entries (`audit_*` in `platform/src/observability/catalog.ts`) use the
  `audit-store` source and are `orgScoped` + `adminOnly`, so the observability
  API applies the same predicate as `GET /audit`
  (`buildAuditQuery` in `platform/src/services/audit-service.ts`).

The cross-service `logAuditEvent` lines described above also land in Loki with
`service_name`, `eventCategory`, `event`, `actor`, and `pluginName` promoted to
labels, searchable in Grafana (Explore → Loki). They carry no org label, so they are not
a tenant-scoped surface. Deep-link to a filtered Audit Activity view via the registry's
`buildAuditLogLink` helper
([frontend/src/lib/registry-audit-link.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/frontend/src/lib/registry-audit-link.ts)).

**Direct LogQL** (hitting Loki at port 3100):

```logql
{service_name="pipeline-image-registry", eventCategory="audit", event="registry.tag.copy"}
  | json
  | isPromotionToSystem=`true`
```

## Action catalog

The full set of platform actions lives in the `AuditAction` union in
[platform/src/models/audit-event.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/platform/src/models/audit-event.ts); the
subset a remote service may emit is `REMOTE_AUDIT_ACTIONS` in
[packages/api-core/src/services/remote-audit-client.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/services/remote-audit-client.ts).

### Platform-emitted

| Area | Actions |
|------|---------|
| User lifecycle | `user.register`, `user.login`, `user.login.failed`, `user.logout`, `user.delete`, `user.profile.update`, `user.password.change`, `user.email.verified`, `user.token.create`, `user.tokens.revoke-all`, `user.session.revoke`, `user.step-up`, `user.password.change_required` (a password sign-in opened no session because the password is shorter than the person's org password policy requires — `details.minLength`; completed by `user.password.change`) — `details.method` is `password`, `webauthn`, `totp` or `reauth`; a passkey sign-in records `details.method: 'webauthn'` on `user.login`, and a password-plus-code sign-in records `details.method: 'pwd+totp'` with `details.via` saying whether a generated or a recovery code was used. `user.login` is filed under the signed-in person (actor and org = the session just opened) with `details.sid` and `details.amr`. `user.login.failed` names the account (`targetId`, `affectedOrgId`) when the identifier resolves to one, and records an SSO-required refusal on any sign-in path as `details.reason: 'sso-enforced'`. A refresh-token reuse that revokes its session is a `user.session.revoke` with `outcome: 'failure'` and `details.reason: 'refresh_reuse'` |
| Passkeys | `user.passkey.register`, `user.passkey.rename`, `user.passkey.remove` — a passkey is a persistent sign-in credential, so both ends of its life are recorded (`details` carries the label the person gave it and whether it is a synced credential). `user.passkey.clone_suspected` — an authenticator's signature counter went **backwards** on a credential that had counted before, i.e. two authenticators answering for one credential; the assertion is refused and this is the only trace it happened |
| Authenticator app (TOTP) | `user.totp.enrol` — emitted TWICE, `details.stage: 'started'` when the secret is minted and `'activated'` when a code confirms it, because a secret that was displayed and then abandoned is still a secret that left the building. `user.totp.disable` is the other end of the factor's life. `user.mfa.recovery_regenerate` — the account's recovery-code set (one set, shared by passkeys and the authenticator app) was replaced, so every previously issued code stopped working. `user.mfa.recovery_used` — a recovery code was **spent** (`details.context` is `login` or `step-up`, `details.remaining` how many are left) — on the authenticator's sign-in leg or on the recovery-only leg a passkey-only account gets when its org requires MFA; its own action rather than a detail on the sign-in, because burning one usually means a lost device, and an attacker who obtained the sheet leaves exactly this trace. Wrong codes are `user.login.failed` with `details.method: 'totp'`, so brute-force shows up on the same trail as password guessing |
| Assurance & required MFA (#8) | `auth.mfa.bootstrap_session` — a sign-in used the **bootstrap-administrator exception**: the install's only admin holding a single-factor session because they have not enrolled one yet. `details.late` is true when it happened more than 24h after the system org was created, which is the alertable case (a fresh install finishes in minutes). `auth.mfa.bootstrap_closed` — their first enrolment closed the exception permanently. `auth.mfa.reset_requested` — an org owner/admin asked for a member's second factors to be reset (`details.reason`, `details.requestId`, `details.expiresAt`); the actor is the requester. `auth.mfa.reset_approved` — a DIFFERENT owner/admin (or a sysadmin, `details.approverIsSysadmin`) approved it and the reset ran: every passkey, the authenticator app and the recovery codes removed, `tokenVersion` bumped, and a per-user enrolment grace granted (`details.graceUntil`); the actor is the approver and `details.requestedBy` the requester. `auth.mfa.reset_denied` — denied, or withdrawn by its requester (`details.withdrawn`). `auth.mfa.direct_reset` — a sysadmin reset a member's factors alone, for an org with no second admin (`details.direct: true`, `details.reason`). `auth.mfa.operator_reset` — an operator ran the same reset with the `scripts/mfa-recover.js` command because nobody could sign in; attributed to the named (self-asserted, `details.operatorAsserted`) operator, never to the account. `org.mfa_policy.update` — an org turned "require MFA" on or off, changed its grace period, changed its statement that its IdP enforces MFA, or changed its "administrative actions require MFA" policy (`details.sessionsRefreshed`: members signed out so turning it on applies at once; 0 when it was turned off); `details` carries both sides of each transition. `org.password_policy.update` / `org.authenticator_policy.update` — an org changed its minimum password length or its approved-authenticator (passkey model / AAGUID) allowlist; `details` carries both sides. `user.mfa.prompt_declined` — a member was offered a second factor by the password-only prompt and chose "don't ask again": a durable decision to stay on one factor, which is why it has its own action rather than being invisible. Their org's admins see the COUNT of it on the two-factor policy panel; this is the only trail that says who. `user.mfa.prompt_restored` — the same person withdrew that decline (or a snooze), without which "declined" would read as permanent. The 7-day "not now" is deliberately NOT audited: a row a week per password-only account would bury both of these. `user.mfa.locked_out` — a run of wrong codes (authenticator app or the recovery-only sign-in leg) crossed the limit and locked the account out of code verification until `details.lockedUntil`; system actor (the guesser is unauthenticated), filed against the account's active org |
| Access keys | `user.key.create`, `user.key.revoke`, `user.key.exchange`, `user.key.exchange.failed`. Every key event — these and the `org.service-account.key.*` family — has `targetType: 'access-key'` and `targetId` the key id (the owning user / service account is in `details`). A refusal of a value that resolved to a real key record (revoked, expired, account disabled) names that key and its org; an unresolvable value has no `targetId` |
| Device authorization | `device.authorize.start`, `device.authorize.approve`, `device.authorize.deny`, `device.authorize.expire` (`targetId` the flow when its record was still readable). The session actually opening on the device is a `user.login` with `details.method: 'device'` and `deviceRequestId`; an approval consumed but voided at issue (account gone, approver's sessions revoked) is the same action with `outcome: 'failure'` |
| Organization | `org.create`, `org.update`, `org.soft_delete`, `org.restore`, `org.team.delete` (a parent admin soft-deleted one of its own teams; `details.parentOrgId`, `purgeAfter`, `snapshotId`, `membersInvalidated`), `org.switch` (an inherited-authority switch into a team adds `details.via: 'ancestor'` and `details.inheritedFromOrgId`), `org.member.add`, `org.member.remove`, `org.member.deactivate`, `org.member.activate`, `org.ownership.transfer`. `org.update` carries `fields` and the `before`/`after` of each named field. `org.impersonation_policy.update` — the org changed who may impersonate its members and how; its own action (not an `org.update`) because loosening it widens who can see the org's data, with `details.before`/`after`. `org.domain.unverified` — the re-verification sweep found a verified domain's DNS proof gone and un-verified it: discovery stops, the join mode is forced `off`, and pending join requests from that domain are cancelled (`details.cancelledJoinRequestIds`, `previousMode`); system actor, `affectedOrgId` the org, `targetId` the domain record. `org.billing.provision` — paid-signup billing provisioning, system actor: `details.result` is `created` (at signup or by the reconcile pass), `deferred` (marked for reconcile, `outcome: 'failure'`) or `lost` (not even the marker landed — the case an operator must act on); a still-pending org's every-interval retry is deliberately not recorded |
| Invitations | `invitation.send`, `invitation.accept`, `invitation.revoke`, `invitation.resend`, `invitation.expire` (the reaper expired a pending invitation past its `expiresAt` — system actor, one row per invitation with its id, `affectedOrgId` the inviting org) |
| Permission roles | `org.role.create`, `org.role.update`, `org.role.delete`, `org.role.member.add`, `org.role.member.remove`. `org.role.update` carries `details.before`/`after` (name, description, permissions); `org.role.delete` the permissions the Role granted and `affectedMembers`. A refused grant above the actor's own ceiling is an `authz.denied` naming the refusal code. The boot-time RBAC backfill writes these same actions under the system actor with `details.reason: 'rbac-backfill'`: a missing built-in Role created, a drifted built-in bundle rewritten (`before`/`after` permissions), a membership's built-in Role assignment added, and an automation service account moved off an admin Role (`org.role.member.remove` + `org.role.member.add`, `targetType: 'service-account'`) |
| Service accounts | `org.service-account.create`, `org.service-account.update`, `org.service-account.delete`, `org.service-account.key.create`, `org.service-account.key.revoke`, `org.service-account.key.rotate`, `org.service-account.key.rotate.failed` |
| SSO provisioning | `org.idp.mapping.upsert`, `org.idp.mapping.delete` — an [IdP group → Role mapping](authentication.md#just-in-time-membership-and-group--role-mapping) was authored or removed (`details` carries the group + Role ids). `sso.jit.provision` — an SSO sign-in created the org membership; `sso.jit.role.change` — a later sign-in added/removed mapped Roles; `sso.jit.refused` — provisioning was turned away (`details.reason`, today `seat_limit`), which also refuses the sign-in |
| SAML sign-in | A successful SAML sign-in is a plain `user.login` with `details.method = 'saml'` — it is the same kind of session, and splitting it would fracture every "who signed in" query. The REFUSAL gets its own action, because SAML fails in ways that are security events rather than someone mistyping a password: `sso.saml.refused` with `details.reason` — `idp_initiated` (an unsolicited assertion: login CSRF), `replay` (an assertion presented twice), `invalid_assertion` (signature, issuer, audience or validity window), `domain_not_verified`, `platform_admin`, `seat_limit`, `invalid_state`, `no_email`, plus the configuration states. `sso.saml.certificate.rotate` records a change to the org's trusted IdP signing certificates — `details` carries the fingerprints before and after and whether an overlap window is now `open`, never the certificates themselves. `sso.saml.logout` records single logout: `details.direction` `sp` (we sent the signed LogoutRequest — `stage: 'request'`, then `'complete'` when the IdP's signed LogoutResponse returns) or `idp` (the IdP's signed LogoutRequest revoked `sessionsRevoked` sessions, `userIds`); a refused logout message is `outcome: 'failure'` with `details.reason`. See [SAML 2.0](authentication.md#saml-20) |
| SSO setup & policy | `sso.test` — a [test connection](authentication.md#test-connection-dry-run) (a dry run that creates no session, user or membership), at `details.stage: 'start'` and `'complete'` — the latter with `ok`, the failure `reason`, the asserted `email` and whether it was `recorded` as the connection's last test; `outcome` follows `ok`. `org.sso.required.update` — the org's [SSO required](authentication.md#sso-required) policy was switched (`details.from` / `to`, `surface`). `org.idp.metadata.import` — IdP SAML metadata was parsed into the form (`details.source` `url` with the fetched `host`, or `xml`; the `entityId` and certificate count) — saving it is a separate `admin.org-idp.upsert` |
| SCIM provisioning | `org.scim.user.create`, `org.scim.user.update`, `org.scim.user.activate`, `org.scim.user.deactivate`, `org.scim.user.delete`, `org.scim.group.create`, `org.scim.group.update`, `org.scim.group.members`, `org.scim.group.delete` — the identity provider's [SCIM 2.0 client](authentication.md#scim-20-provisioning) changed the roster or a directory group. `org.scim.refused` — a SCIM request was turned away (`outcome: 'failure'`, `details.reason`) |
| Dashboards & alerts | `dashboard.create/update/delete/restore/purge/clone`, `alert.destination.create/update/delete/restore/purge/test`, `alert.rule.create/update/delete/restore/purge`. Delete is a SOFT delete: the row is restorable from "recently deleted" until the retention sweep hard-deletes it. `…restore` records bringing one back, `…purge` records destroying a tombstone by hand ahead of the sweep — both re-verify the actor's password (step-up) first |
| Admin / sysadmin | `admin.user.create/update/delete`, `admin.org.delete`, `admin.org.export`, `admin.org-idp.upsert/delete`, `admin.superadmin.grant/revoke`, `admin.org.kms-config.upsert/delete`, `org.kms.orphaned`, `admin.org.tier.update`, `admin.org.move` (sysadmin reparent — `details.fromParentOrgId` / `toParentOrgId`, `null` = standalone root, the resulting `tier`, `membersInvalidated`), `admin.org.seatLimit.update`, `admin.org.ai-config.update`, `admin.user.features.update`, `admin.impersonate.start`, `admin.impersonate.request/approve/deny/revoke/breakglass`, `admin.org.namespace.render`. Impersonation rows name the request as `details.impersonationRequestId` (never `requestId`, which is the HTTP correlation id). A request created but deliverable to nobody is an `admin.impersonate.request` with `outcome: 'failure'` and `reason: 'undeliverable'`; `admin.impersonate.expire` is the reaper expiring a request whose window lapsed unanswered or unredeemed (system actor, `previousStatus`). `admin.user.features.update` and `admin.org.seatLimit.update` carry both sides (`before`/`after` overrides; `previous` seats / support contacts / tier). `observability.pvc.autoexpand`, `observability.postgres.rung`, `observability.node_disk.autoexpand` — Alertmanager-driven autoscaling that actually changed infrastructure (or failed trying), attributed to `alertmanager:<instance>`; `details` carries the from/to size or rung. Refusals (cooldown, ceiling, disabled) are metered, not recorded. The retention sweep's hard deletes of dashboards and alert destinations/rules are `dashboard.purge` / `alert.destination.purge` / `alert.rule.purge` under the system actor with `details.reason: 'retention-purge'` |
| Denied access | `authz.denied` — emitted by the shared permission gate when a state-changing (non-GET) request is rejected, so probing / privilege-escalation attempts leave a trail (`outcome: 'failure'`). Also emitted by `requireInternalService` for a refused INTERNAL route (`/internal/*`, the quota usage counters, the entity-event / audit ingests, the entitlement sync legs), with `required` naming the services that route admits — paired with the `internal_route_refused_total{service,route,reason,caller}` counter, whose `reason` distinguishes a user token from a wrong caller. On platform it is also emitted for every inline authorization refusal a controller makes itself (a target outside the caller's org scope, an owner-only or sysadmin-only write, a dashboard the caller does not own, a read-only impersonation write — `required: 'impersonation-read-only'`), and for a mapped 403 thrown out of a service (e.g. a Role grant above the actor's ceiling), with `required` naming the rule or refusal code |

**Access keys** deserve a note: a key is opaque, so no service ever sees it —
they see the short-lived token it was traded for. `user.key.exchange` is
therefore the **only** record that a key was used at all, and it is what
"which automation is still using key X?" is answered from (`targetId` is the key
id, `details.name` its label, and the row is attributed to the key's owner even
though the exchange request itself carries no identity). Its failure twin,
`user.key.exchange.failed`, records the refusal reason (`unknown`, `revoked`,
`expired`, `authority_revoked`, `user_gone`, `malformed`, and for a
service-account key `account_gone`, `account_disabled`, `ip_not_allowed`,
`budget_exhausted`, `orphan_key`) that the HTTP response deliberately does
**not** differentiate — a run of `unknown` from one IP is a scanner, and the row
carries that IP and user-agent.

**Service accounts** (#2) are principals in their own right, so every row a
service account's key produces names the ACCOUNT as the actor: `actorId` is the
account id and `actorEmail` its `<name>@service-account.invalid` sentinel — never
the person who happened to create it. `user.key.exchange` carries
`details.principalType` (`user` | `service_account`) and, for an account,
`details.serviceAccount`, so "what did this automation do" and "which human did
that" never blur together. The management events above cover the durable grants:
creating an account, changing its roles/budget/disabled state, deleting it, and
issuing or revoking each key (`details.scope` records the one capability a scoped
key carries instead of the account's Roles, and `details.ipAllowlistEntries`
whether a key was pinned to addresses — never which).

**SCIM** (3b) is the other machine trail, and the one an admin reads when a
directory sync has quietly stopped working. The actor is the service account
behind the `scim`-scoped key, exactly as above. `details.changed` names **which
attributes moved — never their values**: a directory sync carries personal data,
and the audit log must not become a second copy of it. A group write additionally
carries `details.membersAffected`, the number of people whose Role set the write
reconciled — the blast radius of one push.

`org.scim.refused` is the half that matters operationally, because a refused sync
is otherwise visible only in the IdP's own console. `details.reason` is a stable
label: `seat_limit` (the account is full — the response names the limit),
`not_entitled` (the SSO entitlement lapsed, so only deactivate and delete are
still accepted; the org's admins are also notified, once a day), `invalid_value`
(most often an unverified email domain), `uniqueness`, `invalid_filter`,
`mutability` (an attempted `userName` rename), `owner_protected`,
`platform_admin`, `not_found`, and `wrong_credential` (something that is not a
`scim`-scoped service-account key tried the endpoint). The same labels appear on
`platform_scim_errors_total{resource,operation,reason}`.

**Self-rotation** (#N2) is the machine half of that trail.
`org.service-account.key.rotate` is emitted when an unattended rotator replaces
its own credential through `POST /auth/key/rotate`: no person is present, so the
row is attributed to the **account**, `targetId` is the account id, and `details`
carries `keyId` (the replacement), `previousKeyId` (what it replaces), `scope`,
and `prunedKeyIds` — siblings platform retired to stay under the active-key cap.
A non-empty `prunedKeyIds` means an EARLIER rotation never revoked its
predecessor, which is worth noticing even though the rotation itself succeeded.
The subsequent retirement lands as an ordinary `org.service-account.key.revoke`
with `details.via: 'self-rotation'`. `org.service-account.key.rotate.failed`
carries the same undifferentiated refusal reasons as the exchange, plus the
rotation-only ones (`not_service_account`, `self_revoke`, `expiry_invalid`,
`key_limit`) — again, reasons the HTTP response does not give away.

**Device authorization** (how `pipeline-manager auth login` signs in — see
[Authentication → CLI sign-in by device authorization](authentication.md#cli-sign-in-by-device-authorization-rfc-8628))
is the one flow whose trail spans an anonymous and an authenticated actor.
`device.authorize.start` is emitted **pre-auth**, so its `actorId` is
`anonymous` and the only identifying detail is `details.client` — the requesting
device's client summary. The decision events carry the person who approved or
refused. All four share a `targetId`: a truncated hash of the device code, which
is what lets "a code was requested from X and approved by Y" be reconstructed
without ever recording the device code or the short user code (both are live
credentials for the flow's 10-minute life). `device.authorize.expire` is written
by whichever side first notices a lapsed code, so a code nobody ever returns to
leaves only its `.start` row.

**Agent-drafted changes** carry `details.proposedBy: 'ask-agent'`. The Ask
panel's "Apply" commits a drafted change through the **same route the dashboard's
own button calls**, with the person's own session and permissions — the agent
never writes — so without this key the trail could not tell "the admin changed
this" from "an AI drafted it and the admin clicked Apply", which mean very
different things in an incident review. The actor is still the person: the key
says how the change was DRAFTED, never who is answerable for it.

The browser asserts it with the `X-PB-Proposed-By` request header, and the
routes that accept it (`pipeline.create`/`.update`, `plugin.deploy`/`.update`,
`pipeline_template.create`/`.update`, `reporting.settings.update`,
`compliance.notification-preference.update`,
`plugin.security_notifications.update`) carry the `proposable` gate. The header's
whole vocabulary is one word: a request naming any other proposer is refused with
a 400 **before** the write, and the handler's own `details` stay authoritative —
provenance can add `proposedBy` and nothing else. A change made by hand records
no `proposedBy` at all, which is what makes the key's presence mean something.
The two proposal kinds that file into an approval QUEUE instead of writing
(`plugin install change-request`, `compliance exemption`) carry the same fact as
a sentence in the `note` / `reason` the approver reads, because there the
provenance has to reach a person, not a query.

Each record carries `actorId`/`actorEmail`, `orgId` (the actor's own org), and
`affectedOrgId` (the org actually operated on). They diverge when a sysadmin acts
on another org, so the trail answers "what did a sysadmin do to org X?" — SOC2
evidence for impersonation-style access (see [Impersonation](permissions.md#impersonation-view-as-user)). `admin.*` actions and
`admin.impersonate.start` set `affectedOrgId` to the target org so the affected
org's own admins can see them.

#### Log-surface egress

| Action | Emitted when | Details |
|---|---|---|
| `observability.logs.export` | Someone downloads log content from **Deliver → Logs** | `format`, `lines`, `bytes`, `truncated`, `from`, `to`, `filter`, `tenantCount` |
| `observability.logs.cross-org-read` | A system admin reads a Loki tenant other than `_infra` | `tenantCount`, `context` (`search` / `context` / `raw`) |

A log export is a cheap request with large egress that leaves the building, so
it is audited like `admin.org.export`. The cross-org read is the log-surface
counterpart to impersonation accountability: viewing another organization's data
is recorded even though it changes nothing. See [Logs](observability-logs.md).

### Service-emitted (`REMOTE_AUDIT_ACTIONS`)

| Service | Actions |
|---------|---------|
| Plugin | `plugin.build.completed`, `plugin.build.failed`, `plugin.build.timeout`, `plugin.delete`, `plugin.restore`, `plugin.purge`, `plugin.update`, `plugin.upload`, `plugin.deploy`, `plugin.bulk.update`, `plugin.bulk.delete`, `plugin.dlq.purge`, `plugin.build.retry`, `plugin.dlq.replay` (the last two are queue-triage re-runs — re-enqueueing a failed or dead-lettered build; `affectedOrgId` is the job's owning org, which differs from the caller's on a sysadmin retry), `plugin.scan.skipped` (a version persisted **unscanned** because the build-time scan could not run and the operator escape hatch `PLUGIN_ALLOW_UNSCANNED` is on; `details`: name, version, digest). A build blocked by a scan gate ends in `plugin.build.failed` with `details.errorCode` = `IMAGE_SCAN_UNAVAILABLE` or `PLUGIN_VULN_GATE`, and `details.refusedImage` saying what became of the pushed image (`discarded`, `kept_in_use`, `kept_setup_load` — a system-org setup catalog load, kept for promotion — or `failed`). Promoting a kept setup image records `plugin.setup_image.promoted` (`targetId` the new plugin id; `details`: name, version, digest, the original refusal code, waived count, DB build time) or `plugin.setup_image.promote_refused` (`targetId` the digest; `details.errorCode` and the advisory ids still failing). Two more record a decision rather than a build: `plugin.shadowing.denied` (an upload refused because the name would shadow an ecosystem plugin; `details`: name, version, what it shadows) and `plugin.vuln.waived` (a vulnerability gate passed under a waiver — at build `targetId` is the image DIGEST, not a plugin id, because it runs before the plugin row exists; from the nightly rescan, which records it only when the waiver newly covers a finding, `targetType` is `plugin` or `listing-version` and `targetId` that row's id, with `details.trigger: rescan`). The nightly rescan also records `plugin.vuln.flagged` and `plugin.vuln.cleared` when a stored version crosses the vulnerability floor in either direction (actor `system`; `details`: counts, KEV count, the gated advisory ids, the image digest) — recorded only AFTER the row update commits, and every row of one pass shares its run id (`jobId: vuln-rescan`). The same pass records `pipeline.vuln.reopened` (actor `system`, `details.trigger: 'lapsed'`, `exposureId`, `acceptedUntil`, `triagedBy`) for each risk acceptance whose deadline passed. A refused build's `plugin.build.failed` also carries `targetId` (the plugin name), `requestId` (the upload's — the same on its `plugin.upload` row), `imageDigest`, `keptSetupImageId` and the refusing `advisoryIds`. `plugin.setup_image.kept` — a refused setup-load image kept for promotion (`details`: digest, refusal code, expiresAt); `plugin.setup_image.discarded` — the sweep dropped its row (`details.reason`: `expired` / `superseded`, `imageDiscarded`). `plugin.delete` / `plugin.purge` with outcome `failure` and `details.refusal: PLUGIN_VERSION_IN_USE` — a removal refused because pipelines still reference the version (`details.pipelineIds`, counts). The retention sweep's hard-deletes record `plugin.purge` too, once per tick (system actor, `details.trigger: 'retention'`, `runId`, `count`). `plugin.dlq.purge` is recorded under the system org with each discarded job's id and owning org. `plugin.version.yank` carries the reason, the digest and the in-use counts. `pipeline.runtime_check.flagged` — a pipeline's runtime check graded a running image `error` or louder (`details`: stepKey, digest, reason codes, and `executionId` when the caller sent it); triage rows (`pipeline.vuln.*`) carry `details.advisoryIds` |
| Plugin security notifications (org-local) | `plugin.security_notifications.update` (`org_settings:write`; `details`: changed field NAMES, recipient mode + count, digest mode, rescan opt-in, the webhook HOST, whether a secret / external address is set and whether a confirmation was sent — never the secret, the URL path/query or the address), `plugin.security_notifications.external_email.verify` (actor `anonymous`: the address's emailed single-use link was confirmed; `orgId` = the org whose address it is), `plugin.security_notifications.test` (`details`: the per-channel outcome of the test send) |
| Pipeline | `pipeline.create`, `pipeline.update` (`details.changes`: before/after values of the scalar fields that changed — name, visibility, active, default, owner, lifecycle, criticality; a compliance-refused create/update is recorded with outcome `failure`, `details.blockedBy: compliance` and the violated `ruleIds`; bulk rows are one event each sharing a `details.batchId`), `pipeline.delete`, `pipeline.restore`, `pipeline.purge` (the retention sweep's hard-deletes are recorded under it too, by the system actor: `details.trigger: retention`, the sweep's `runId` and the `count`), `pipeline.execution.start`, `pipeline.execution.cancel` (`targetType` `pipeline_execution`, `targetId` the execution id, `details.pipelineId`; a failed start or stop is recorded with outcome `failure` and a `details.reason`), `pipeline.registry.register`, `pipeline.registry.deregister` (delete, purge, register and deregister carry the counts of plugin vulnerability exposures they closed or opened), `pipeline.plugin.upgraded` (plugin steps moved to newer versions through the upgrade flow; `details`: the steps, from → to, and one `batchId` per apply), `pipeline.security_report.upload` (a pipeline run uploaded a scanner report; `details`: tool, format, stage and the finding counts — never the findings). A pipeline's vulnerability triage, recorded by the plugin service (`targetType` `pipeline`, `targetId` the pipeline id; `details`: the exposure ids — the declared and deployed rows of one version move together — plugin, version, image digest, reason, the previous state): `pipeline.vuln.accepted` (a time-boxed risk acceptance; also `acceptedUntil`, the number of finding keys frozen, and `kev` — true only when the request said `kev: true` for a version with known-exploited findings), `pipeline.vuln.false_positive`, `pipeline.vuln.reopened`. An acceptance downgrades that pipeline's warnings and notices for the accepted findings only; vulnerability state never blocks a pipeline either way |
| Pipeline templates | `pipeline_template.create`, `pipeline_template.update`, `pipeline_template.delete`, `pipeline_template.restore`, `pipeline_template.purge` (own action family, gated by `templates:*` rather than `pipelines:*`; `create`/`update` `details` carry the template's `visibility` rung) |
| Quota | `quota.reset`, `quota.limit.update`, `quota.delete`, `quota.notice_settings.update` |
| Compliance | `compliance.exemption.approve`, `compliance.exemption.revoke`, `compliance.rule.toggle`, `compliance.rule.create/update/delete/restore/purge`, `compliance.policy.create/update/delete/restore/purge`, `compliance.scan-schedule.create/update/delete`, `compliance.template.apply`, `compliance.scan.create`, `compliance.scan.cancel`, `compliance.notification-preference.update` (changed field names + webhook host only — never the destination secret). `compliance.exemption.request` (filed, single or bulk — metadata only, never the reason) and `compliance.exemption.reject`; `compliance.exemption.approve` carries `ruleId`, `entityType`, `entityId`, `requester` and `expiresAt`, and is recorded with outcome `failure` (`details.refusal: CE_SELF_APPROVE`) when a requester tries to approve their own. Rule, policy and scan-schedule updates carry `details.changes` — before → after of the enforcement-bearing fields. The retention sweep's hard-deletes record `compliance.rule.purge` / `compliance.policy.purge`, once per tick (system actor, `details.trigger: 'retention'`, `runId`, `count`). A scheduled scan writes `compliance.scan.create` (`details.triggeredBy: 'scheduled'`, `scheduleId`); every scan's end writes `compliance.scan.complete` (success with pass/warn/block counts, or failure). `compliance.subscription.auto-subscribe` — platform onboarding subscribed a new org to the published rules (inactive; `details.subscribed`) |
| Image registry | `registry.gc`, `registry.image.delete`, `registry.image.copy` (all carry `affectedOrgId` = the org owning the repository — `org-<id>/…`, or the system org for `system/…` — so that org's admins see changes an operator made to their images); `registry.image.sign` — a plugin image signed and SBOM-attested with the platform plugin-signing key at the plugin build worker's request (`details.digest`; `affectedOrgId` = the owning org). `registry.token.issue` — the Docker token endpoint minted a token that grants access (`details.granted`: repo + actions, the credential KIND, `push`); a refused credential is the same action with outcome `failure` (`details.usernameHash`, never the username or credential); the scope-less `docker login` probe is not recorded. `registry.quarantine.credential.mint` — a push credential for one anonymous submission's quarantine repo (expiry, TTL). `registry.gc` is recorded under the actor's org (the system org for the scheduler) and lists the deleted digests; a refused-build discard (`registry.image.delete`, `details.scope: refused-build` or `kept-setup-image`) is attributed to the user whose build it was and carries the refusal code, plugin version, job and request ids. A copy or repo prune that died part-way is recorded with outcome `failure` and what it had already changed. The public-namespace actions (`registry.image.publish/resign/yank/gc`) are attributed to the approving moderator or the user who triggered the re-sign, not to `system`. A cross-org signing/discard/publish call and a repo outside the caller's org are refused and recorded as `authz.denied` |
| Message | `message.announcement.create`, `message.delete`, `message.restore`, `message.purge` (admin broadcasts + the destructive lifecycle; the retention sweep's hard-deletes record `message.purge` too, once per tick with system actor, `details.trigger: retention`, the tick's `runId` and the `count`), `message.update` (an author editing a sent message — `details.contentLength`, `threadId`, `messageType`; a refused edit of a message that is not the caller's, or does not exist, is a `failure` row), `message.attachment.upload` (`details.surface` = `message`/`support`, `contentType`, `sizeBytes` — never the bytes and not the filename, which is user-chosen content), `message.notify.internal` (a SYSTEM notification an internal service dropped into an org's inbox; system actor, `details.caller` names the service, `targeted`, `priority`), `message.org.purge` (the platform org-delete cascade reclaiming an org's attachment blobs — `details.blobsDeleted`, or a `failure` row when the reclaim did not complete, the orphaned-data case). 1:1 sends and replies are still deliberately NOT audited, and no message body, subject or edit text ever reaches `details` |
| Support | `support.case.open`, `support.case.reply` — the exception to the Message row above, which does not audit ordinary replies. A support case is not an ordinary message: it carries a **response-time commitment**, so who raised it, when, under which level, and when we first answered are the facts a dispute turns on. `support.case.open` carries `caseNumber`, `level`, `severity` and `openedWithIncident`; `support.case.reply` is recorded for the STAFF side only (a tenant answering its own case is correspondence, not a response to it) and carries `firstResponse` — whether that reply was the one that stopped the clock. `targetId` is the thread root id, which IS the case identity, so the trail and the product agree on what "this case" means. **Metadata only — no message body, ever.** The four WORKFLOW actions are now live too, each carrying `from`/`to` because the transition is the fact rather than the end state: `support.case.status` (stops or restarts the response clock; `byStaff` distinguishes a tenant closing its own case from us resolving it), `support.case.severity` (**staff only** — the tenant picks severity at open, so if they could re-rank it afterwards they would choose the target they are owed; this is the record of who changed it and from what, without which a downgrade before a breach is invisible), `support.case.assign` (the staff owner; `to: null` is a release to the unowned pool, not a missing value) and `support.case.transfer` (the tenant owner — `createdBy` is deliberately absent from its `details`, because who RAISED a case never changes and recording it in a handover would blur the one fact the trail must keep stable). The two CONTACT actions are live as well, and they are ENTITLEMENT events rather than case events: `support.contact.designate` and `support.contact.revoke` (platform, `org_settings:write`) each change who in an org is able to commit us to a response target at all, and designating spends a slot of a paid, account-pooled allowance. `designate` carries the `level`, the `limit` and `usedBefore` — a later dispute about who was entitled to raise a case turns on what was true when they were nominated, not on what the account holds today. `revoke` carries `openCasesLeftBehind`, because revoking is deliberately not blocked on a departing contact's open cases (refusing to remove a leaver because they still own cases would be worse than handing the cases on), so the count makes an orphaned case a recorded fact rather than a later discovery. The premium UPGRADE has its own pair, `support.contact.upgrade` and `support.contact.downgrade` (platform, `org_settings:write`), separate from designation because they answer to a different cap (`supportPremiumContacts`) and carry a different fact: WHO was entitled to 24×7 coverage, and WHEN. A dispute over an unanswered out-of-hours case turns on exactly that, and collapsing them into `designate` would lose it. Both carry the `premiumLimit` as it stood. Note a downgrade never weakens a case already raised — `support_case.level` is frozen at open, which is why these routes touch no case rows. `support.case.note` is live too, on all three staff-note routes (`support_cases:write`): a note is the vendor's internal assessment of a customer and the ONE surface on a case the tenant must never see, so both writing and removing one is recorded. **Metadata only — the note BODY never reaches the trail**, only the case number, the note id and its length, because the central audit trail is read far more widely than the support queue is and putting internal commentary about a customer into it would defeat the point of the notes being separate. Deleting is SOFT for the same reason the row is kept: a note records what the desk believed at the time, and a dispute may turn on it. `support.canned.write` covers the canned-reply library (create / edit / retire, `support_content:write`) — ONE action for all three verbs, because the trail's question is "who changed the wording the desk sends customers", not which verb they used, and `details` carries that. The templates are system-wide rather than per-tenant, so those rows name no affected org. **CSAT is deliberately NOT audited** (a waiver recorded in message's `route-coverage.test.ts`): a customer's 1-to-5 opinion of their own closed case changes no entitlement, no ownership and no clock, and it is the one case write staff may not make, so there is no privilege movement to record either — auditing it would only add noise to a trail read for authorization questions. The signal lives in the `satisfaction` column and the `support_satisfaction` histogram instead. `plugin.review.anonymize` is now live and emitted by platform's user-deletion path: GDPR erasure scrubs a deleted person out of the listing reviews they left — `authorUserId`, the display name and the body all go NULL while the RATING survives, because a rating is part of a listing's public aggregate that other customers rely on and deleting the row would silently rewrite it. `authorOrgId` is deliberately kept: it is never exposed, it identifies the organisation rather than the person, and it is what the anti-gaming rules (no self-review, per-org rate limit, verified-use) run on. The row carries the COUNT only — never the prose removed, since putting it in the trail would defeat the erasure the trail is recording. It fires POST-COMMIT of the Mongo cascade and is idempotent, so a retry cannot scrub reviews for a user whose deletion rolled back. The three ON-CALL actions are live: `support.oncall.acknowledged`, `support.oncall.escalated` and `support.oncall.test`. These exist because PagerDuty owns the rota, the escalation and the contact methods, but cannot own an auditable answer to "who picked this up at 03:14" — a click on a link in the provider's UI is not an identity this system can attest to. So their incident state changes are relayed to `POST /observability/oncall-ack` (signature-verified, fail-closed) and recorded against the agent they name, as `pagerduty:<id>`: deliberately NOT resolved to a local user, because inventing that mapping would assert an identity we cannot verify. `acknowledged` carries `ackSeconds` only when both timestamps were present — a missing one is omitted rather than recorded as 0, since a 0 would read as an instant acknowledgement, the most flattering possible lie about response time. `escalated` is a separate action rather than a detail on the first, because it is the record that the FIRST responder did not answer — the fact a rota gets adjusted on, and the one most likely to be disputed later. `support.oncall.test` is audited because it RINGS A PHONE: whoever it wakes is entitled to a record of who caused that, at whatever hour it was. A provider `incident.resolved` echo is deliberately NOT audited — the resolve is already our own act (the reply that stopped the clock, or the alert clearing), so recording their echo would double-record an event this system caused. `support.oncall.paged` records the per-case sweep paging the rota for a premium case nearing its first-response target (system actor, `affectedOrgId` the case's org, `details` = `caseNumber`, `severity`, `responseDueAt`, `leadMinutes`; the tick's `runId`/`trigger` come from the job audit context). It is written ONCE, on the tick the case entered the lead window — the sweep re-sends the same page every tick to stay stateless, and a row per re-send would record one page two dozen times. A failed send on that tick is a `failure` row. One action remains planned, `support.case.read`, which will be the only record that someone at the vendor opened a customer's case |
| Billing | `billing.subscription.create`, `billing.subscription.update`, `billing.subscription.reactivate`, `billing.subscription.cancel`, `billing.subscription.delete`, `billing.tier.override`, `billing.addon.add`, `billing.addon.remove`, `billing.addon.prune`, `billing.discount.generate`, `billing.discount.issue`, `billing.discount.apply`, `billing.discount.remove`, `billing.discount.revoke`, `billing.credit.consumed`, `billing.credit.exhausted`, `billing.combo.expired` (mirrored to the central trail alongside the service-local `billing_events`; `details` carry plan/tier/addon/discount/combo ids + cents only — never payment secrets, coupon tokens, or signing keys). Campaigns — the identity a set of codes belongs to, carrying the shared budget, window and one-per-account rule — are their own **system-admin-only** family: `billing.campaign.create`, `billing.campaign.update` (budget/window/exclusivity; a budget below committed spend is refused) and `billing.campaign.end` (ends the campaign AND deactivates every code in it — `details.discountsDeactivated` records how many). Promotions are a separate, **system-admin-only** family: `billing.promotion.create` (mint), `billing.promotion.update` (edit), `billing.promotion.revoke` (soft-revoke — stops future auto-grants; credits already granted are NOT clawed back), `billing.promotion.grant` (grant to one org, bypassing eligibility matching but still honouring budget and idempotency) and `billing.promotion.activate` (fan out to the eligible base, budget-bounded) |
| Reporting | `reporting.settings.update` (the incident→deploy correlation window, which moves reported CFR/MTTR), `reporting.deployment.outcome` (a deploy-outcome marker, same), `reporting.retention.sync` (an inbound billing→reporting retention entitlement — a cut destroys history at the next sweep; carries `affectedOrgId`). Stakeholder reports carry their own family, each naming the permission that reached it: `reporting.report.definition.create/update/delete` and `reporting.report.ownership.transfer` (`reports:write`); `reporting.report.recipient.added` and `reporting.report.recipient.removed` (`reports:write`); `reporting.report.link.created` and `reporting.report.link.revoked` (`reports:publish` — a share link is an unauthenticated read of org data, so both ends are recorded); `reporting.report.published` and `reporting.report.republished` (`reports:publish`); `reporting.report.policy.update` (`org_settings:write`); and `reporting.report.paused` and `reporting.report.resumed`, which are emitted by INTERNAL service callers rather than a person — paused when platform reports the owner left the org (authority is re-checked every run; ONE row per definition, each with its own `targetId`), resumed when billing restores the entitlement. A SCHEDULED auto-send records the same `reporting.report.published` / `.republished` a manual publish does, attributed to the definition's owner with `details.trigger: 'schedule'`. Before/after: `reporting.deployment.outcome` carries `before` (the marker of the same outcome it replaced, or null), `reporting.settings.update` and `reporting.report.policy.update` carry `before`, `reporting.report.definition.update` carries `before`/`after` for the fields that moved, and `reporting.retention.sync` carries `before` plus `billingOccurredAt` (billing's own instant for the change — the correlation key back to its `billing_events` row). The drafting half of a run is recorded too: `reporting.report.run.compose` (a compose or regenerate froze the org's numbers into a run; `regenerate`, period, version), `reporting.report.run.notes` (the lead's notes were edited — length only, never the prose), `reporting.report.run.summary` (an AI executive summary was drafted from the run's numbers; a refusal is `outcome: failure` with its `reason`, never the text) and `reporting.report.recipient.resend` (a recipient's confirmation credential was re-minted). Two are the UNAUTHENTICATED recipient's own acts, actor `anonymous` and the address only as a truncated SHA-256 (`recipientHash`): `reporting.report.recipient.verified` (the address became deliverable — the single-use token is consumed, so one row per token) and `reporting.report.recipient.unsubscribed` (only the click that actually stopped delivery; a repeat click or an unknown token writes nothing). **Machine ingest** (`reporting:ingest` scope) is no longer unaudited telemetry: every POST to `/reports/events`, `/reports/incidents`, `/reports/incidents/alertmanager` and `/reports/ingest-health` records one `reporting.ingest.batch` (actor = the credential's principal, `targetId` the source route; `details`: received / inserted / deduplicated / skipped-unregistered / dropped counts, capped `pipelineIds`, `executionIds`, `sourceEventIds` — the EventBridge event ids — and `incidentIds`, `keyId`, `truncated` when a list hit its cap of 50). Events naming pipelines that resolve to an org the credential may not write for record `reporting.ingest.rejected` (`outcome: failure`, `reason: foreign_org`, the offending `pipelineIds` and `keyId` — never the org they belong to). A missing `reporting:ingest` scope and an ingest-health heartbeat naming another org are `authz.denied`; every refusal is also counted in `reporting_ingest_rejected_total{reason}`. `reporting.incident.record` is one incident that is NEW or actually CHANGED (opened, re-opened, resolved, re-ranked) with `before`/`after` — like a deployment-outcome marker it moves CFR/MTTR — and a sender's unchanged repeat-interval re-post writes none. Each stored event row also carries `source_event_id` (the EventBridge id, also a dedup key) and `ingest_key_id`, and `dora_deployments.source_event_id` names the deploy event behind a DORA row |
| Ask (assistant) | `ask.query` (read-only how-to turn), `ask.agent.turn` (tool-calling turn) — one per turn on `POST /ask`, `/ask/stream`, `/ask/agent/stream` respectively; both carry an `outcome` (success/failure, incl. client-abort) and `details` with SAFE METADATA ONLY (tools used, proposal kinds, source count, query *length*, the RESOLVED `provider` and `model`, and `quota` — the `aiCalls` slot the turn reserved: `slot` = `kept` once the provider responded or `refunded` when it was never reached, plus the reservation's `used`/`limit`) — never the raw query text. Confirmed drafts commit through the normal create routes, so the resource itself is audited as `pipeline.create` / `pipeline_template.create` / `plugin.deploy`. `ask.feedback` records a reader's verdict on an answer (`details.rating` = `up`/`down`) together with the DOC IDS it cited (`details.sources`, e.g. `authentication.md`) — the doc is what gets corrected, and unlike the question it is not the user's own words. A help search that found nothing is counted in the `help_search_miss_total` metric only, never here: the search text would be the one actionable field and it is user-entered |
| AI generation | `pipeline.ai.generate` (`POST /pipelines/generate`, `/generate/stream`, `/generate/from-url`, `/generate/from-url/stream`), `plugin.ai.generate` (`POST /plugins/generate`, `/generate/stream`) — one row per generation, with an `outcome` (success, or failure incl. client abort — `details.aborted` — and a repository analysis that failed before any AI call — `details.analysisFailed`) and `details` with SAFE METADATA ONLY: `route`, the prompt *length*, `errorCode` on a failure, and `ai` — the provider and `model` that ANSWERED (after org-key selection and any platform failover; `fallbackFrom` names the provider first resolved), `keySource` (`request` = the caller's own key, `org` = the organization's configured key, `platform`), `tokens` (input/output/cached input), the `promptVersion` and `quotaSlot` (`kept` once the provider responded, `refunded` when it was never reached) — plus `quota`, the reservation's `used`/`limit`. Absent `ai` means the run failed before a provider was chosen (AI turned off, nothing configured). Never the prompt, the generated config or a key. A generated draft is only a draft: what the user then saves is audited as `pipeline.create` / `plugin.deploy`, and placeholder plugins a from-URL generation proposed are created only when the user confirms them (`POST /pipelines/generate/missing-plugins`, each recorded as `plugin.deploy` by the plugin service) |
| Plugin ecosystem: publishers | `publisher.create`, `publisher.update`, `publisher.terms.accept` (`details.termsVersion`), `publisher.verify.request/approve/reject`, `publisher.tier.change` (`details.reason = 'plan_downgrade'` when a Verified grace period ends), `publisher.suspend`, `publisher.unsuspend`, `publisher.transfer.request/accept/decline/approve/reject`, `publisher.profile-change.approve/reject` |
| Plugin ecosystem: publish requests (tenant → system org) | `plugin.request.submit` (`details.kind`: `new_listing` / `new_version` / `listing_update` / `yank` / `unpause` / `transfer` / `claim` / `profile_change` / `verify` / `advisory`, or `moderation` for a system-org two-person action — unsuspend, unyank, relist, tier to Verified — whose initiator's `plugin.request.approve` is the first approval; `details.digest`; `details.securityFix`), `plugin.request.withdraw`, `plugin.request.approve` (`details.firstOfTwo = true` when it parks a two-person request), `plugin.request.second-approve`, `plugin.request.reject` (`details.reason = 'listings_quota'` when over the plan's `listings` limit), `plugin.request.auto-approve` (actor `system`, `details.autoRuleId`, or `details.bootstrap = true` for the one-time catalog seed). A decision refused by separation of duties is recorded as the attempted action with outcome `failure` (`details.refusal: SEPARATION_OF_DUTIES`). `ecosystem.bootstrap.open` / `ecosystem.bootstrap.close` — the one-time bootstrap window opening on the first Official request, and closing for good (`details.reason`, `details.approved`) |
| Plugin ecosystem: listings and versions | `plugin.listing.publish` (on approval; carries `digest`, `tier`), `plugin.listing.update`, `plugin.listing.state.change` (`unmaintained` / `suspended` / `listed` — this is how a listing is withdrawn; a separate `unlist` action was declared and never emitted, and has been removed), `plugin.listing.pause` / `plugin.listing.unpause` (tenant pause; unpause on approval), `plugin.version.pause`, `plugin.version.yank`, `plugin.version.unyank`, `plugin.version.deprecate`. Distinct from all four, `plugin.version.prune` is a TENANT retiring a version's registry image to reclaim `storageBytes` (`plugins:write`): the others change whether a version resolves and delete nothing, while this one removes the version tag so its layers leave the organization's storage total. `details` carry `repo`, `tag` and `freedBytes` — the bytes recorded because they cannot be recovered afterwards: once the tag is gone, what it uniquely occupied is unknowable. A refusal is the same action with outcome `failure` and `details.refusal` (`in_use` — a pipeline still references it, `published` — a published copy whose bytes stay billed until the listing is withdrawn, `unknown_version`, or `registry_unavailable`); the registry's own side of the deletion is `registry.tag.delete` with `details.reason: storage_prune`. `plugin.collection.update` is gone too: `ecosystem_collections` was deleted because nothing ever wrote or read one, and the action outlived the table it audited |
| Plugin ecosystem: governance rules | Every decision is recorded with `orgId` = the system org and `affectedOrgId` = the publisher's org (tenant submissions: `orgId` = the publisher's org). Automatic decisions use actor `system`. `details` carry ids, versions, digests, tier, state and short reason text only — never README content, metadata values or emails |
| Plugin ecosystem: configuration (system org) | `ecosystem.auto-approval-rule.create/update/delete`, `ecosystem.reserved-name.update`. There is no `ecosystem.sla.update`: the lane SLAs are HARDCODED (standard 48h, security-fix 4h) with no settings surface, so there is no mutation to audit — making them operator-tunable is the change that should re-add it |
| Plugin ecosystem: public registry namespace | `registry.image.publish` (copy to `public/*` + fresh sign + SBOM attest; also the unyank re-tag, `details.retag: true`, which restores the version tag from the `public/*` manifest alone), `registry.image.resign` (the re-sign job after a tier change, suspension, handle change or transfer — one per image, emitted by image-registry; the plugin service emits one more with `targetId: all` when an Ecosystem Manager queues a full re-sign after a plugin-signing key rotation), `registry.image.yank` (`public/*` tag removal on yank or takedown), `registry.image.gc` (`public/*` retention sweep) |
| Plugin ecosystem: installs and policy | `plugin.install.create` (an install that needed no approval, active at once), `plugin.install.request` (an install that became a pending request), `plugin.install.approve` / `plugin.install.deny` (actor = the approver), `plugin.install.upgrade` (a change of version or version policy), `plugin.install.change-request` (a member asked for a change that needs an approver), `plugin.install.change-approve` / `plugin.install.change-reject` (actor = the approver; an approval also records the `plugin.install.upgrade` it applies), `plugin.install.remove` (uninstall, or a withdrawn request), `org.plugin-install-policy.update` (org-local; set by `plugin_installs:manage` with a step-up). Every one: `orgId` = the actor's org, `affectedOrgId` = the **installing org** (a team's own installs and policy → the team). Implicit Official installs are virtual and are never audited; creating or removing an explicit Official install is |
| Plugin ecosystem: reviews | `plugin.review.create/update/delete` (by the author), `plugin.review.report`, `plugin.review.hold`, `plugin.review.release`, `plugin.review.remove` (moderator), `plugin.review.anonymize` (user deletion), `plugin.review.reply.create/update/delete` |
| Plugin ecosystem: anonymous submissions | `plugin.submission.create` (actor `anonymous`), `plugin.submission.verify`, `plugin.submission.gate-fail`, `plugin.submission.approve`, `plugin.submission.reject`, `plugin.submission.claim`, `plugin.submission.expire` (actor `system`) |
| Plugin ecosystem: advisories | `plugin.advisory.create` (draft: publisher, moderator, or `system` from a CVE rescan), `plugin.advisory.update` (edit an existing advisory; carries `affectedOrgId` = the publisher's owning org), `plugin.advisory.publish` and `plugin.advisory.withdraw` (system org only) |
| (all services) | `authz.denied` |

#### Plugin ecosystem: actor and affected-org rules

The ecosystem actions above
follow these rules:

- **Actor:** `actorId({ userId })` as everywhere else. Automated jobs (auto-approval,
  submission expiry, the re-sign job, CVE rescans) use the `system` sentinel
  (`SYSTEM_ACTOR_ID`). An **unauthenticated** anonymous submission uses the
  `anonymous` sentinel (`ANONYMOUS_ACTOR_ID`, exported from api-core next to
  `SYSTEM_ACTOR_ID`) with `details.submissionId`. The submitter's email, hashed or
  otherwise, never appears in audit.
- **`orgId`:** the actor's org. Anonymous and system actions use the system org.
  **Governance actions are recorded with `orgId` = the system org**, so the system
  org's audit view is the complete record of every ecosystem decision.
- **`affectedOrgId`:** listing, version, review and advisory actions → the
  **publisher's org**; install and policy actions → the **installing org**;
  moderation actions on a publisher → the publisher's org. That org's admins
  therefore see changes made *to* them.
  Install and policy actions are org-local: the publisher is never told which
  orgs installed its listing.
- **`details`:** ids, versions, digests, tier, state, reason *code* and short
  reason text only. **Never** review bodies, README content, secrets or emails.
- **Access:** refused use of a system-org-only permission and refused writes
  through an install the org's policy blocks are `authz.denied`. A governance
  route reached from a tenant org — even by the same person, even a Super Admin —
  is refused by `requireSystemOrg` and recorded as `authz.denied` with
  `required: 'system-org'`. Ecosystem Manager assignment and removal are the
  existing `org.role.member.add` / `org.role.member.remove` with `affectedOrgId`
  = the system org and `details.role = 'Ecosystem Manager'` (and send N23 to
  every Super Admin and the affected user).
- **Audit page:** two quick filters sit next to the `authz.denied` one —
  **Ecosystem** (`publisher.*`, `plugin.listing.*`, `plugin.request.*`,
  `plugin.install.*`, `org.plugin-install-policy.update`) and **Moderation**
  (`plugin.submission.*`, `plugin.request.approve` / `reject` / `auto-approve` /
  `second-approve`, `plugin.review.hold` / `release` / `remove`,
  `publisher.suspend` / `unsuspend` / `verify.*`, `ecosystem.*`). A group is
  one `GET /audit?actions=<a>,<b>,…` request: each entry is a prefix (ending in
  `.`) or an exact action, matched anchored and ORed, and ANDed with any
  `action=` substring filter. At most 25 entries.

Not audited (by design): anonymous directory reads, searches, review "helpful"
votes, and notification deliveries — those are metrics, not state changes.

Review actions (W4) carry `details.listing` (`publisher/name`) and, as they
apply, `rating`, `version`, `verifiedUse`, `held` (the hold reason of a new or
edited review that went to moderation), `changed` (the edited fields) and the
report `category` — never the review, reply or report text. A hold triggered
automatically by reports or a security report is recorded with actor `system`,
`orgId` = the system org and `details.trigger`; moderator decisions
(`plugin.review.hold` / `release` / `remove`, and `plugin.review.reply.delete`
with `details.by: moderator`) also use the system org. `affectedOrgId` is the
publisher's org. `plugin.review.anonymize` is reserved for GDPR user deletion,
which is not wired to platform's account deletion yet.

Anonymous submission actions (W5) carry `details.submissionId`, the plugin
`name` and `version`, and, as they apply: the failed gate ids on
`plugin.submission.gate-fail`, the request id and `listing` (`community/name`)
on `plugin.submission.approve`, the reason text on `plugin.submission.reject`,
and the claiming publisher on `plugin.submission.claim`. `plugin.submission.create`
and `plugin.submission.verify` use actor `anonymous`; gate results and
`plugin.submission.expire` use `system`; approve and reject are the deciding
moderator, and the queue decision is also recorded as `plugin.request.approve` /
`plugin.request.reject` on the `submission` request. All use `orgId` = the system
org. The submitter's email (plain, hashed or encrypted) is never in `details`,
and neither are the heuristics excerpts.

> **Plugin build terminal outcome** — `plugin.build.failed` / `plugin.build.timeout`
> is emitted at TRUE dead-letter-queue exhaustion, not at the tier queue's final
> attempt. A job that fails the tier queue but later succeeds in the DLQ emits
> only `plugin.build.completed` — the trail records exactly one terminal outcome
> per build, never a "failed" that a later "completed" contradicts.

## Registry structured-log events

Independently of the Mongo trail, image-registry emits `eventCategory: 'audit'`
structured log lines (via `logAuditEvent(logger, event)` in
[packages/api-core/src/utils/audit.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/utils/audit.ts))
that the log aggregator (Loki, in the default deploy) routes into a dedicated
stream. The event-name union is
[packages/api-core/src/types/audit-events.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/types/audit-events.ts).

### `registry.tag.copy`

Emitted by [image-registry's `POST /api/images/copy`](https://github.com/mwashburn160/pipeline-builder/blob/main/api/image-registry/openapi.yaml)
after a successful cross-repo tag copy.

| Field | Type | Description |
|-------|------|-------------|
| `event` | `'registry.tag.copy'` | Constant discriminator |
| `actor` | `string` | `req.user.sub` of the sysadmin who initiated the copy |
| `source` | `string` | Source `<repo>:<ref>` |
| `target` | `string` | Target `<repo>:<ref>` |
| `sourceDigest` | `string` | Resolved digest of the source manifest |
| `targetDigest` | `string` | Resolved digest of the target manifest |
| `isPromotionToSystem` | `boolean` | `true` when the target repo starts with `system/` — the highest-privilege case |
| `mounted.manifests` | `number` | Total manifests PUT |
| `mounted.blobs` | `number` | Count of UNIQUE blob digests cross-mounted |

**Why `isPromotionToSystem` matters**: copying any tag into `system/*` makes the
image visible to every authenticated user. Operators should alert on these
specifically — they're meaningful trust escalations.

### `registry.tag.delete`

Emitted by [image-registry's `DELETE /api/images/{name}/manifests/{reference}`](https://github.com/mwashburn160/pipeline-builder/blob/main/api/image-registry/openapi.yaml)
after a successful delete.

| Field | Type | Description |
|-------|------|-------------|
| `event` | `'registry.tag.delete'` | Constant discriminator |
| `actor` | `string` | `req.user.sub` of the sysadmin who initiated the delete |
| `repo` | `string` | Repository name (e.g. `org-acme/foo`) |
| `ref` | `string` | Tag or digest the operator passed in |
| `digest` | `string` | Resolved manifest digest that was actually deleted |

## Adding a new audit event

**Platform-emitted** (user/org lifecycle):

1. Add the action to the `AuditAction` union AND the `ALL_AUDIT_ACTIONS` array in
   [platform/src/models/audit-event.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/platform/src/models/audit-event.ts).
2. Call `audit(req, 'new.action', { targetType, targetId, affectedOrgId, details })`
   from the controller after the mutation succeeds. Keep secrets / tokens / AWS
   account ids out of `details`.
3. Declare it on the route with api-core's `audited('new.action')` middleware, so
   the route table records it and the service's
   [route-coverage test](permissions.md#route-coverage) counts the write route as
   audited (an undeclared write route fails that test).
4. Document it in the [action catalog](#action-catalog) above.

**Service-emitted** (a non-platform service):

1. Add the action to `REMOTE_AUDIT_ACTIONS` in
   [remote-audit-client.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/services/remote-audit-client.ts)
   AND to the platform `AuditAction` union / `ALL_AUDIT_ACTIONS` (the subset-guard
   test enforces `REMOTE_AUDIT_ACTIONS ⊆ AuditAction`).
2. Emit it with `recordAudit({ action, actorId, orgId, targetId, details })` (from `@pipeline-builder/api-core`) after the mutation succeeds — no service argument; the service is the one bound by `wireServiceSecurity`. In tests, pass a spy as `apiCoreMock({ recordAudit: spy })`, or call `bindTestAuditService(serviceName)` from `@pipeline-builder/api-core/testing` when the suite runs the real api-core.
3. Declare it on the route with api-core's `audited('new.action')` middleware (see
   [route coverage](permissions.md#route-coverage)) — the per-service test fails
   on a write route that declares no action, and on an action that isn't in
   `REMOTE_AUDIT_ACTIONS`.
4. Document it in the [service-emitted catalog](#service-emitted-remote_audit_actions) above.

Use the dot-separated `<area>.<entity>.<verb>` naming convention so events sort
and filter cleanly.

## Related

- [Permissions](permissions.md) — the gates that emit `authz.denied`, and route coverage
- [Logs](observability-logs.md) — the separate application-log surface
- [Authentication](authentication.md) — the sign-in, SSO and key flows most of these actions record
- [Environment Variables](environment-variables.md) — the full audit configuration reference
