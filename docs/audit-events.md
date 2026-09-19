---
layout: default
title: Audit Events
image: /assets/og-image-audit.png
---

# Audit Events

Pipeline Builder keeps a **tamper-evident audit trail** in the `platform`
service's MongoDB `audit_events` collection. Two emitters feed it, and a
separate structured-log path exists for the image registry.

- **Platform-direct** — the `platform` service writes user/org lifecycle events
  straight to Mongo via the `audit()` helper
  ([platform/src/helpers/audit.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/platform/src/helpers/audit.ts)) and
  `auditService.createEvent(...)`.
- **Service-remote** — every other service (pipeline, plugin, quota, compliance,
  image-registry, message, billing, reporting) POSTs its events to the platform
  ingest `POST /audit/events` through the shared `RemoteAuditClient`
  ([packages/api-core/src/services/remote-audit-client.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/services/remote-audit-client.ts)).
- **Registry structured logs** — image-registry ALSO emits `eventCategory: 'audit'`
  log lines to Loki for a couple of registry operations (see
  [Registry structured-log events](#registry-structured-log-events)).

Both emitter paths funnel through one appender (`appendAuditEvent` in
[platform/src/helpers/audit-chain.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/platform/src/helpers/audit-chain.ts)),
so every stored event is hash-chained and scrubbed the same way.

Query the trail via `GET /audit` (admin-only; org admins are forced to their own
org, sysadmins may filter any org) or the dashboard **Audit** page at
`/dashboard/audit`. Records auto-expire via a MongoDB TTL index after
`config.audit.retentionDays` days (default 90, overridable via
`AUDIT_RETENTION_DAYS`).

---

## Overview

This reference explains how Pipeline Builder produces, secures, and queries its audit trail, and catalogs every action it records. It's for compliance reviewers and operators. It covers the emitter paths (platform-direct writes, the service-remote `POST /audit/events` ingest, and the registry's Loki structured logs), the per-tenant SHA-256 hash-chain integrity model, sensitive-data scrubbing, and the full [action catalog](#action-catalog) — platform-emitted lifecycle events plus the `REMOTE_AUDIT_ACTIONS` subset (including billing subscription, tier, `addon`, and `discount` actions). The catalog stays in sync with the `AuditAction` union in code; see [Adding a new audit event](#adding-a-new-audit-event) to extend it.

---

## Integrity & tamper-evidence

Every event is linked into a **per-tenant SHA-256 hash chain**: each row stores a
`hash` over its immutable fields plus the `prevHash` of the previous event in the
same chain (chain key = `affectedOrgId ?? orgId`). Altering, reordering, or
deleting a stored event breaks the chain.

- **Verify** — `GET /audit/verify?orgId=<id>` (sysadmin-only) walks a tenant's
  chain and returns `{ ok, brokenAt?, count }`. `ok:false` with `brokenAt` set
  means the chain is broken at that event. The dashboard **Audit** page surfaces
  this as a **Verify integrity** action for sysadmins.
- **Retention-aware** — verify anchors on the first *surviving* event's
  `prevHash`, so an org older than the retention window (whose genesis rows have
  aged out under the TTL) does **not** false-alarm. Tampering with any event that
  still has a surviving successor is detected; truncation of the oldest
  contiguous prefix is indistinguishable from normal TTL pruning.
- **`occurredAt`** — events carry an `occurredAt` (when the action really
  happened), stored for reviewers. It is deliberately **not** the chain-ordering
  field — the chain orders by ingest `createdAt` — so a delayed/spooled delivery
  never perturbs chain consistency or verification.

### Sensitive-data scrubbing

`appendAuditEvent` runs `scrubAwsIdentifiers()` over every event's `details`
before hashing and storing, redacting AWS-account-id-shaped tokens (including the
account segment of any ARN) and account-named keys. **An AWS account id is never
persisted** — `orgId` is the marketplace `customerIdentifier`, never an AWS
account id. Emitters must also keep secrets/tokens out of `details`; the frontend
applies a second redaction pass before rendering or exporting.

---

## Service-remote ingest (`POST /audit/events`)

Non-platform services deliver events through `RemoteAuditClient`, which is
best-effort and **fire-and-forget** — a failed audit never blocks or fails the
originating mutation. Three properties make it safe and durable:

- **Anti-forgery subset lock** — the ingest authenticates the caller as a service
  principal (`requireServiceAuth`) and validates `action` against the
  `REMOTE_AUDIT_ACTIONS` allow-list (`isRemoteAuditAction`), **not** the full
  platform `AuditAction` union. A service token therefore cannot forge
  platform-authority events (`admin.superadmin.grant`, `org.ownership.transfer`,
  `user.login`, …). A `REMOTE_AUDIT_ACTIONS ⊆ AuditAction` test guards drift.
- **Idempotent** — each emission carries a stable `Idempotency-Key`; the ingest
  dedups on it (unique index), so a retried delivery collapses to a single stored
  row and a single chain link.
- **Durable spool** — if the platform is down past the client's retry budget, the
  event is buffered in a bounded Redis spool
  ([packages/api-core/src/services/audit-spool.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/services/audit-spool.ts))
  and re-delivered on recovery instead of being lost. The spool drops the OLDEST
  on overflow (with a metric) so it can never grow unbounded. A spooled event
  reuses its `Idempotency-Key`, so a live attempt and its later re-delivery
  dedup to one row.

**Observability** — audit loss is metered, not just logged:
`audit_emitted_total`, `audit_dropped_total`,
`audit_spool_{enqueued,dropped,redelivered}_total`.

---

## Action catalog

The full set of platform actions lives in the `AuditAction` union in
[platform/src/models/audit-event.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/platform/src/models/audit-event.ts); the
subset a remote service may emit is `REMOTE_AUDIT_ACTIONS` in
[packages/api-core/src/services/remote-audit-client.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/services/remote-audit-client.ts).

### Platform-emitted

| Area | Actions |
|------|---------|
| User lifecycle | `user.register`, `user.login`, `user.login.failed`, `user.logout`, `user.delete`, `user.profile.update`, `user.password.change`, `user.email.verified`, `user.token.create`, `user.tokens.revoke-all`, `user.session.revoke`, `user.step-up` — `details.method` is `password`, `webauthn`, `totp` or `reauth`; a passkey sign-in records `details.method: 'webauthn'` on `user.login`, and a password-plus-code sign-in records `details.method: 'pwd+totp'` with `details.via` saying whether a generated or a recovery code was used |
| Passkeys | `user.passkey.register`, `user.passkey.rename`, `user.passkey.remove` — a passkey is a persistent sign-in credential, so both ends of its life are recorded (`details` carries the label the person gave it and whether it is a synced credential). `user.passkey.clone_suspected` — an authenticator's signature counter went **backwards** on a credential that had counted before, i.e. two authenticators answering for one credential; the assertion is refused and this is the only trace it happened |
| Authenticator app (TOTP) | `user.totp.enrol` — emitted TWICE, `details.stage: 'started'` when the secret is minted and `'activated'` when a code confirms it, because a secret that was displayed and then abandoned is still a secret that left the building. `user.totp.disable` is the other end of the factor's life. `user.totp.recovery_regenerate` — the recovery sheet was replaced, so every previously issued code stopped working. `user.totp.recovery_used` — a recovery code was **spent** (`details.context` is `login` or `step-up`, `details.remaining` how many are left); its own action rather than a detail on the sign-in, because burning one usually means a lost device, and an attacker who obtained the sheet leaves exactly this trace. Wrong codes are `user.login.failed` with `details.method: 'totp'`, so brute-force shows up on the same trail as password guessing |
| Assurance & required MFA (#8) | `auth.mfa.bootstrap_session` — a sign-in used the **bootstrap-administrator exception**: the install's only admin holding a single-factor session because they have not enrolled one yet. `details.late` is true when it happened more than 24h after the system org was created, which is the alertable case (a fresh install finishes in minutes). `auth.mfa.bootstrap_closed` — their first enrolment closed the exception permanently. `auth.mfa.operator_reset` — an operator removed every factor from an account with the `scripts/mfa-recover.js` command; attributed to the named operator, never to the account, and it also bumps `tokenVersion`. `org.mfa_policy.update` — an org turned "require MFA" on or off, changed its grace period, or changed its statement that its IdP enforces MFA; `details` carries both sides of each transition |
| Access keys | `user.key.create`, `user.key.revoke`, `user.key.exchange`, `user.key.exchange.failed` |
| Device authorization | `device.authorize.start`, `device.authorize.approve`, `device.authorize.deny`, `device.authorize.expire` |
| Organization | `org.create`, `org.update`, `org.soft_delete`, `org.restore`, `org.switch`, `org.member.add`, `org.member.remove`, `org.member.deactivate`, `org.member.activate`, `org.ownership.transfer` |
| Invitations | `invitation.send`, `invitation.accept`, `invitation.revoke`, `invitation.resend` |
| Permission roles | `org.role.create`, `org.role.update`, `org.role.delete`, `org.role.member.add`, `org.role.member.remove` |
| Service accounts | `org.service-account.create`, `org.service-account.update`, `org.service-account.delete`, `org.service-account.key.create`, `org.service-account.key.revoke`, `org.service-account.key.rotate`, `org.service-account.key.rotate.failed` |
| SSO provisioning | `org.idp.mapping.upsert`, `org.idp.mapping.delete` — an [IdP group → Role mapping](authentication.md#just-in-time-membership-and-group--role-mapping) was authored or removed (`details` carries the group + Role ids). `sso.jit.provision` — an SSO sign-in created the org membership; `sso.jit.role.change` — a later sign-in added/removed mapped Roles; `sso.jit.refused` — provisioning was turned away (`details.reason`, today `seat_limit`), which also refuses the sign-in |
| SAML sign-in | A successful SAML sign-in is a plain `user.login` with `details.method = 'saml'` — it is the same kind of session, and splitting it would fracture every "who signed in" query. The REFUSAL gets its own action, because SAML fails in ways that are security events rather than someone mistyping a password: `sso.saml.refused` with `details.reason` — `idp_initiated` (an unsolicited assertion: login CSRF), `replay` (an assertion presented twice), `invalid_assertion` (signature, issuer, audience or validity window), `domain_not_verified`, `platform_admin`, `seat_limit`, `invalid_state`, `no_email`, plus the configuration states. `sso.saml.certificate.rotate` records a change to the org's trusted IdP signing certificates — `details` carries the fingerprints before and after and whether an overlap window is now `open`, never the certificates themselves. See [SAML 2.0](authentication.md#saml-20) |
| SCIM provisioning | `org.scim.user.create`, `org.scim.user.update`, `org.scim.user.activate`, `org.scim.user.deactivate`, `org.scim.user.delete`, `org.scim.group.create`, `org.scim.group.update`, `org.scim.group.members`, `org.scim.group.delete` — the identity provider's [SCIM 2.0 client](authentication.md#scim-20-provisioning) changed the roster or a directory group. `org.scim.refused` — a SCIM request was turned away (`outcome: 'failure'`, `details.reason`) |
| Dashboards & alerts | `dashboard.create/update/delete/restore/purge/clone`, `alert.destination.create/update/delete/restore/purge/test`, `alert.rule.create/update/delete/restore/purge`. Delete is a SOFT delete: the row is restorable from "recently deleted" until the retention sweep hard-deletes it. `…restore` records bringing one back, `…purge` records destroying a tombstone by hand ahead of the sweep — both re-verify the actor's password (step-up) first |
| Admin / sysadmin | `admin.user.create/update/delete`, `admin.org.delete`, `admin.org.export`, `admin.org-idp.upsert/delete`, `admin.superadmin.grant/revoke`, `admin.org.kms-config.upsert/delete`, `org.kms.orphaned`, `admin.org.tier.update`, `admin.org.seatLimit.update`, `admin.org.quota.override`, `admin.org.ai-config.update`, `admin.user.features.update`, `admin.impersonate.start`, `admin.impersonate.request/approve/deny/revoke/breakglass`, `admin.org.namespace.render` |
| Denied access | `authz.denied` — emitted by the shared permission gate when a state-changing (non-GET) request is rejected, so probing / privilege-escalation attempts leave a trail (`outcome: 'failure'`). Also emitted by `requireInternalService` for a refused INTERNAL route (`/internal/*`, the quota usage counters, the entity-event / audit ingests, the entitlement sync legs), with `required` naming the services that route admits — paired with the `internal_route_refused_total{service,route,reason,caller}` counter, whose `reason` distinguishes a user token from a wrong caller |

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
| Plugin | `plugin.build.completed`, `plugin.build.failed`, `plugin.build.timeout`, `plugin.delete`, `plugin.restore`, `plugin.purge`, `plugin.update`, `plugin.upload`, `plugin.deploy`, `plugin.bulk.update`, `plugin.bulk.delete`, `plugin.dlq.purge`, `plugin.build.retry`, `plugin.dlq.replay` (the last two are queue-triage re-runs — re-enqueueing a failed or dead-lettered build; `affectedOrgId` is the job's owning org, which differs from the caller's on a sysadmin retry) |
| Pipeline | `pipeline.create`, `pipeline.update`, `pipeline.delete`, `pipeline.restore`, `pipeline.purge`, `pipeline.execution.start`, `pipeline.execution.cancel`, `pipeline.registry.register`, `pipeline.registry.deregister` |
| Pipeline templates | `pipeline_template.create`, `pipeline_template.update`, `pipeline_template.delete`, `pipeline_template.restore`, `pipeline_template.purge` (own action family, gated by `templates:*` rather than `pipelines:*`; `create`/`update` `details` carry the template's `visibility` rung) |
| Quota | `quota.reset`, `quota.limit.update`, `quota.delete` |
| Compliance | `compliance.exemption.approve`, `compliance.exemption.revoke`, `compliance.rule.toggle`, `compliance.rule.create/update/delete/restore/purge`, `compliance.policy.create/update/delete/restore/purge`, `compliance.scan-schedule.create/update/delete`, `compliance.template.apply`, `compliance.scan.create`, `compliance.scan.cancel`, `compliance.notification-preference.update` (changed field names + webhook host only — never the destination secret) |
| Image registry | `registry.gc`, `registry.image.delete`, `registry.image.copy` (all carry `affectedOrgId` = the org owning the repository — `org-<id>/…`, or the system org for `system/…` — so that org's admins see changes an operator made to their images) |
| Message | `message.announcement.create`, `message.delete`, `message.restore`, `message.purge` (admin broadcasts + the destructive lifecycle only — 1:1 messages, replies, edits and attachment uploads are deliberately NOT audited, and no message body reaches `details`) |
| Billing | `billing.subscription.create`, `billing.subscription.update`, `billing.subscription.reactivate`, `billing.subscription.cancel`, `billing.subscription.delete`, `billing.ledger.backfill`, `billing.tier.override`, `billing.addon.add`, `billing.addon.remove`, `billing.addon.prune`, `billing.discount.generate`, `billing.discount.issue`, `billing.discount.apply`, `billing.discount.remove`, `billing.discount.revoke`, `billing.credit.consumed`, `billing.credit.exhausted`, `billing.combo.expired` (mirrored to the central trail alongside the service-local `billing_events`; `details` carry plan/tier/addon/discount/combo ids + cents only — never payment secrets, coupon tokens, or signing keys) |
| Reporting | `reporting.settings.update` (the incident→deploy correlation window, which moves reported CFR/MTTR), `reporting.deployment.outcome` (a deploy-outcome marker, same), `reporting.retention.sync` (an inbound billing→reporting retention entitlement — a cut destroys history at the next sweep; carries `affectedOrgId`) |
| Ask (assistant) | `ask.query` (read-only how-to turn), `ask.agent.turn` (tool-calling turn) — one per turn on `POST /ask`, `/ask/stream`, `/ask/agent/stream` respectively; both carry an `outcome` (success/failure, incl. client-abort) and `details` with SAFE METADATA ONLY (tools used, proposal kinds, source count, query *length*) — never the raw query text. Confirmed drafts commit through the normal create routes, so the resource itself is audited as `pipeline.create` / `pipeline_template.create` / `plugin.deploy` |
| (all services) | `authz.denied` |

> **Plugin build terminal outcome** — `plugin.build.failed` / `plugin.build.timeout`
> is emitted at TRUE dead-letter-queue exhaustion, not at the tier queue's final
> attempt. A job that fails the tier queue but later succeeds in the DLQ emits
> only `plugin.build.completed` — the trail records exactly one terminal outcome
> per build, never a "failed" that a later "completed" contradicts.

---

## Registry structured-log events

Independently of the Mongo trail, image-registry emits `eventCategory: 'audit'`
structured log lines (via `emitAudit` in
[packages/api-core/src/utils/audit.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/utils/audit.ts))
that the log aggregator (Loki, in the default deploy) routes into a dedicated
stream. The event-name union is
[packages/api-core/src/types/audit-events.ts](https://github.com/mwashburn160/pipeline-builder/blob/main/packages/api-core/src/types/audit-events.ts).

### Querying

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

The cross-service `emitAudit` lines described above also land in Loki with
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

---

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
2. Emit it via the service's `getAuditClient().record({ action, actorId, orgId, targetId, details }, '<service>')` after the mutation succeeds.
3. Declare it on the route with api-core's `audited('new.action')` middleware (see
   [route coverage](permissions.md#route-coverage)) — the per-service test fails
   on a write route that declares no action, and on an action that isn't in
   `REMOTE_AUDIT_ACTIONS`.
4. Document it in the [service-emitted catalog](#service-emitted-remote_audit_actions) above.

Use the dot-separated `<area>.<entity>.<verb>` naming convention so events sort
and filter cleanly.
