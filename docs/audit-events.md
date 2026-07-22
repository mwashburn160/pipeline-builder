---
layout: default
title: Audit Events
image: /assets/og-image-audit.png
---

# Audit Events

Pipeline Builder emits audit events through two complementary paths.

## Path 1: Platform (MongoDB-backed)

The `platform` service writes user/org lifecycle events directly to its
MongoDB `audit_events` collection via the `audit()` helper in
[platform/src/helpers/audit.ts](../platform/src/helpers/audit.ts). These
are queryable via the platform's own audit API (`GET /audit`, admin-only
and org-scoped for org admins).

The full set of actions lives in the `AuditAction` union in
[platform/src/models/audit-event.ts](../platform/src/models/audit-event.ts),
grouped by area:

| Area | Actions |
|------|---------|
| User lifecycle | `user.register`, `user.login`, `user.login.failed`, `user.logout`, `user.delete`, `user.profile.update`, `user.password.change`, `user.token.create`, `user.tokens.revoke-all` |
| Organization | `org.create`, `org.member.add`, `org.member.remove`, `org.member.role.update`, `org.member.deactivate`, `org.member.activate`, `org.ownership.transfer` |
| Permission groups | `org.group.create`, `org.group.update`, `org.group.delete`, `org.group.member.add`, `org.group.member.remove` |
| Dashboards | `dashboard.create`, `dashboard.update`, `dashboard.delete`, `dashboard.clone` |
| Alerts | `alert.destination.create/update/delete`, `alert.rule.create/update/delete` |
| Admin | `admin.user.delete`, `admin.org.delete`, `admin.org.export`, `admin.org-idp.upsert/delete`, `admin.superadmin.grant/revoke`, `admin.org.kms-config.upsert/delete`, `admin.org.tier.update`, `admin.org.seatLimit.update`, `admin.impersonate.start`, `admin.org.namespace.render` |
| Plugin builds | `plugin.build.completed`, `plugin.build.failed`, `plugin.build.timeout` |

Each record carries an `actorId`/`actorEmail`, `orgId` (the actor's own
org), and an `affectedOrgId` (the org actually operated on). They diverge
when a sysadmin acts on another org, so the audit log can answer "what did
a sysadmin do to org X?" — required for SOC2 evidence on impersonation-style
access. Records auto-expire via a MongoDB TTL index after
`config.audit.retentionDays` days (default 90, overridable via
`AUDIT_RETENTION_DAYS`).

These persist in MongoDB and are largely out of scope for this document.
See [platform/src/models/audit-event.ts](../platform/src/models/audit-event.ts)
for the document schema, and [Cross-service events](#cross-service-events)
below for the structured-log path that is this document's focus.

## Path 2: Cross-service (structured logs)

Other services emit audit events as structured log lines that the log
aggregator (Loki, in our default deploy) routes into a dedicated stream.
There are two categories on this path:

- **`eventCategory: 'audit'`** — emitted by `image-registry` via the
  `emitAudit` helper in
  [packages/api-core/src/utils/audit.ts](../packages/api-core/src/utils/audit.ts).
  Covered in detail below.
- **`eventCategory: 'plugin-build'`** — emitted by the plugin build worker
  (`api/plugin/src/queue/plugin-build-queue.ts`) for `plugin.build.*`
  outcomes. These are also forwarded to platform's MongoDB audit store via
  the `POST /audit/events` ingest endpoint, so they show up on both paths.

**Best-effort**: if the logger fails, the originating mutation still
succeeds. We don't roll back a successful operation because the audit
write didn't land.

The event-name union is the single source of truth:
[packages/api-core/src/types/audit-events.ts](../packages/api-core/src/types/audit-events.ts).
Adding a new event requires updating that union, this document, and the
emitting route.

### Querying

Audit events land in Loki with `service_name`, `eventCategory`, `event`,
`actor`, and `pluginName` promoted to labels (plus `level`; see
[deploy/<target>/config/promtail/promtail-config.yml](../deploy/aws/ec2/config/promtail/promtail-config.yml)).
Digest fields are intentionally not promoted — they're per-event unique, so
labeling them would blow up Loki's label cardinality.

**From the UI**: the **Audit Activity** dashboard at
`/dashboard/observability/audit-activity` is the operator-facing surface.
Deep-link straight to a filtered view:
`/dashboard/observability/audit-activity?event=registry.tag.copy&since=<iso>&until=<iso>`.
The registry's `buildAuditLogLink` helper
([frontend/src/lib/registry-audit-link.ts](../frontend/src/lib/registry-audit-link.ts))
builds these URLs from a RecentActionsPanel row click, centering a 5-minute
window on the event's timestamp (and passing `digest` for forward-compat).
This is the native replacement for the old Grafana Explore deep-link, so
operators can confirm an event landed without leaving Pipeline Builder.

**Direct LogQL** (for ad-hoc investigations, hitting Loki at port 3100):

```logql
{service_name="pipeline-image-registry", eventCategory="audit", event="registry.tag.copy"}
  | json
  | isPromotionToSystem=`true`
```

Stream selectors on the promoted labels (`service_name`, `eventCategory`,
`event`, `actor`, `pluginName`) are the fast path. Anything else (e.g.
`isPromotionToSystem`, `sourceDigest`) requires `| json` parsing.

---

## Cross-service events

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
| `targetDigest` | `string` | Resolved digest of the target manifest (same as source for an exact copy) |
| `isPromotionToSystem` | `boolean` | `true` when the target repo starts with `system/` — the highest-privilege case |
| `mounted.manifests` | `number` | Total manifests PUT (1 for single-arch; 1 + N children for an index) |
| `mounted.blobs` | `number` | Count of UNIQUE blob digests cross-mounted across the manifest tree |

**Why `isPromotionToSystem` matters**: copying any tag into `system/*`
makes the image visible to every authenticated user. Operators should
alert / report on these specifically — they're meaningful trust
escalations.

Example event:

```json
{
  "level": "info",
  "service": "pipeline-image-registry",
  "eventCategory": "audit",
  "event": "registry.tag.copy",
  "actor": "user-abc123",
  "source": "org-acme/foo:rc1",
  "target": "system/foo:1.0.0",
  "sourceDigest": "sha256:abcdef…",
  "targetDigest": "sha256:abcdef…",
  "isPromotionToSystem": true,
  "mounted": { "manifests": 3, "blobs": 12 }
}
```

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

Distribution deletes manifests by digest, so every tag pointing to the
same digest becomes broken. The audit record stores only the digest;
listing affected tags is a UI-side concern (the delete-confirm modal
shows it on user interaction — see `frontend/src/components/registry/DeleteTagConfirm.tsx`).

Example event:

```json
{
  "level": "info",
  "service": "pipeline-image-registry",
  "eventCategory": "audit",
  "event": "registry.tag.delete",
  "actor": "user-abc123",
  "repo": "org-acme/foo",
  "ref": "rc1",
  "digest": "sha256:abcdef…"
}
```

---

## Adding a new audit event

1. Add a new interface to [packages/api-core/src/types/audit-events.ts](../packages/api-core/src/types/audit-events.ts) and extend the `AuditEvent` union.
2. Call `emitAudit(logger, { event: 'new.event.name', … })` from the route after the mutation succeeds.
3. Document the event in this file (one section per event with the fields table + example).
4. Use the dot-separated `<area>.<entity>.<verb>` naming convention so events sort + filter cleanly.
