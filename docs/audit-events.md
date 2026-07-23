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
  ([platform/src/helpers/audit.ts](../platform/src/helpers/audit.ts)) and
  `auditService.createEvent(...)`.
- **Service-remote** — every other service (pipeline, plugin, quota, compliance,
  image-registry, message, billing, reporting) POSTs its events to the platform
  ingest `POST /audit/events` through the shared `RemoteAuditClient`
  ([packages/api-core/src/services/remote-audit-client.ts](../packages/api-core/src/services/remote-audit-client.ts)).
- **Registry structured logs** — image-registry ALSO emits `eventCategory: 'audit'`
  log lines to Loki for a couple of registry operations (see
  [Registry structured-log events](#registry-structured-log-events)).

Both emitter paths funnel through one appender (`appendAuditEvent` in
[platform/src/helpers/audit-chain.ts](../platform/src/helpers/audit-chain.ts)),
so every stored event is hash-chained and scrubbed the same way.

Query the trail via `GET /audit` (admin-only; org admins are forced to their own
org, sysadmins may filter any org) or the dashboard **Audit** page at
`/dashboard/audit`. Records auto-expire via a MongoDB TTL index after
`config.audit.retentionDays` days (default 90, overridable via
`AUDIT_RETENTION_DAYS`).

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
  ([packages/api-core/src/services/audit-spool.ts](../packages/api-core/src/services/audit-spool.ts))
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
[platform/src/models/audit-event.ts](../platform/src/models/audit-event.ts); the
subset a remote service may emit is `REMOTE_AUDIT_ACTIONS` in
[packages/api-core/src/services/remote-audit-client.ts](../packages/api-core/src/services/remote-audit-client.ts).

### Platform-emitted

| Area | Actions |
|------|---------|
| User lifecycle | `user.register`, `user.login`, `user.login.failed`, `user.logout`, `user.delete`, `user.profile.update`, `user.password.change`, `user.email.verified`, `user.token.create`, `user.tokens.revoke-all` |
| Organization | `org.create`, `org.update`, `org.soft_delete`, `org.restore`, `org.switch`, `org.member.add`, `org.member.remove`, `org.member.deactivate`, `org.member.activate`, `org.ownership.transfer` |
| Invitations | `invitation.send`, `invitation.accept`, `invitation.revoke`, `invitation.resend` |
| Permission roles | `org.role.create`, `org.role.update`, `org.role.delete`, `org.role.member.add`, `org.role.member.remove` |
| Dashboards & alerts | `dashboard.create/update/delete/clone`, `alert.destination.create/update/delete/test`, `alert.rule.create/update/delete` |
| Admin / sysadmin | `admin.user.create/update/delete`, `admin.org.delete`, `admin.org.export`, `admin.org-idp.upsert/delete`, `admin.superadmin.grant/revoke`, `admin.org.kms-config.upsert/delete`, `org.kms.orphaned`, `admin.org.tier.update`, `admin.org.seatLimit.update`, `admin.org.quota.override`, `admin.org.ai-config.update`, `admin.user.features.update`, `admin.impersonate.start`, `admin.org.namespace.render` |
| Denied access | `authz.denied` — emitted by the shared permission gate when a state-changing (non-GET) request is rejected, so probing / privilege-escalation attempts leave a trail (`outcome: 'failure'`) |

Each record carries `actorId`/`actorEmail`, `orgId` (the actor's own org), and
`affectedOrgId` (the org actually operated on). They diverge when a sysadmin acts
on another org, so the trail answers "what did a sysadmin do to org X?" — SOC2
evidence for impersonation-style access. `admin.*` actions and
`admin.impersonate.start` set `affectedOrgId` to the target org so the affected
org's own admins can see them.

### Service-emitted (`REMOTE_AUDIT_ACTIONS`)

| Service | Actions |
|---------|---------|
| Plugin | `plugin.build.completed`, `plugin.build.failed`, `plugin.build.timeout`, `plugin.delete`, `plugin.upload`, `plugin.deploy`, `plugin.bulk.update`, `plugin.bulk.delete`, `plugin.dlq.purge` |
| Pipeline | `pipeline.create`, `pipeline.update`, `pipeline.delete`, `pipeline.execution.start`, `pipeline.execution.cancel`, `pipeline.registry.register`, `pipeline.registry.deregister` |
| Quota | `quota.reset`, `quota.limit.update`, `quota.delete` |
| Compliance | `compliance.exemption.approve`, `compliance.exemption.revoke`, `compliance.rule.toggle`, `compliance.rule.create/update/delete`, `compliance.policy.create/update/delete`, `compliance.scan-schedule.create/update/delete`, `compliance.template.apply`, `compliance.scan.cancel` |
| Image registry | `registry.gc`, `registry.image.delete` |
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
[packages/api-core/src/utils/audit.ts](../packages/api-core/src/utils/audit.ts))
that the log aggregator (Loki, in the default deploy) routes into a dedicated
stream. The event-name union is
[packages/api-core/src/types/audit-events.ts](../packages/api-core/src/types/audit-events.ts).

### Querying

Audit log lines land in Loki with `service_name`, `eventCategory`, `event`,
`actor`, and `pluginName` promoted to labels. **From the UI**, the **Audit
Activity** dashboard at `/dashboard/observability/audit-activity` is the
operator-facing surface; deep-link to a filtered view via the registry's
`buildAuditLogLink` helper
([frontend/src/lib/registry-audit-link.ts](../frontend/src/lib/registry-audit-link.ts)).

**Direct LogQL** (hitting Loki at port 3100):

```logql
{service_name="pipeline-image-registry", eventCategory="audit", event="registry.tag.copy"}
  | json
  | isPromotionToSystem=`true`
```

### `registry.tag.copy`

Emitted by [image-registry's `POST /api/images/copy`](../api/image-registry/openapi.yaml)
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

Emitted by [image-registry's `DELETE /api/images/{name}/manifests/{reference}`](../api/image-registry/openapi.yaml)
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
   [platform/src/models/audit-event.ts](../platform/src/models/audit-event.ts).
2. Call `audit(req, 'new.action', { targetType, targetId, affectedOrgId, details })`
   from the controller after the mutation succeeds. Keep secrets / tokens / AWS
   account ids out of `details`.
3. Document it in the [action catalog](#action-catalog) above.

**Service-emitted** (a non-platform service):

1. Add the action to `REMOTE_AUDIT_ACTIONS` in
   [remote-audit-client.ts](../packages/api-core/src/services/remote-audit-client.ts)
   AND to the platform `AuditAction` union / `ALL_AUDIT_ACTIONS` (the subset-guard
   test enforces `REMOTE_AUDIT_ACTIONS ⊆ AuditAction`).
2. Emit it via the service's `getAuditClient().record({ action, actorId, orgId, targetId, details }, '<service>')` after the mutation succeeds.
3. Document it in the [service-emitted catalog](#service-emitted-remote_audit_actions) above.

Use the dot-separated `<area>.<entity>.<verb>` naming convention so events sort
and filter cleanly.
