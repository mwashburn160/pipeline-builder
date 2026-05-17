# Audit Events

Pipeline Builder emits audit events through two complementary paths.

## Path 1: Platform (MongoDB-backed)

The `platform` service writes user/org lifecycle events directly to its
MongoDB `audit_events` collection via the `audit()` helper in
[platform/src/helpers/audit.ts](../platform/src/helpers/audit.ts). These
are queryable via the platform's own audit API.

Current platform events:

| Action | When |
|--------|------|
| `user.register` | New user account created |
| `user.login` | User signs in |
| `user.logout` | User signs out |
| `user.delete` | User account deleted |
| `user.tokens.revoke-all` | User invalidates all their sessions |
| `org.create` | New organization created |
| `admin.user.delete` | System admin deletes a user |
| `admin.org.delete` | System admin deletes an organization |

These persist in MongoDB and are not the focus of this document. See
[platform/src/models/audit-event.ts](../platform/src/models/audit-event.ts)
for the document schema.

## Path 2: Cross-service (structured logs)

Other services (currently just `image-registry`) emit audit events as
structured log lines via the `emitAudit` helper in
[packages/api-core/src/utils/audit.ts](../packages/api-core/src/utils/audit.ts).
Each line carries `eventCategory: 'audit'` so the log aggregator (Loki,
in our default deploy) can route these into a dedicated stream.

**Best-effort**: if the logger fails, the originating mutation still
succeeds. We don't roll back a successful operation because the audit
write didn't land.

The event-name union is the single source of truth:
[packages/api-core/src/types/audit-events.ts](../packages/api-core/src/types/audit-events.ts).
Adding a new event requires updating that union, this document, and the
emitting route.

### Querying

In Grafana / Loki, filter on `eventCategory = "audit"` and the desired
`event` value:

```logql
{service="pipeline-image-registry"}
  | json
  | eventCategory="audit"
  | event="registry.tag.copy"
  | isPromotionToSystem=`true`
```

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
