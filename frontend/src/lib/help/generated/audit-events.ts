// GENERATED FROM docs/audit-events.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SPDX-License-Identifier: Apache-2.0
import { ScrollText } from 'lucide-react';
import type { HelpTopic } from '../types';

export const auditEventsTopic: HelpTopic = {
  "icon": ScrollText,
  "id": "audit-events",
  "title": "Audit Events",
  "description": "How Pipeline Builder records and surfaces audit events",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Pipeline Builder keeps a tamper-evident audit trail in the platform service's MongoDB audit_events collection. Two emitters feed it, and a separate structured-log path exists for the image registry."
        },
        {
          "type": "list",
          "items": [
            "Platform-direct — the platform service writes user/org lifecycle events"
          ]
        },
        {
          "type": "text",
          "content": "straight to Mongo via the audit() helper (platform/src/helpers/audit.ts) and auditService.createEvent(...)."
        },
        {
          "type": "list",
          "items": [
            "Service-remote — every other service (pipeline, plugin, quota, compliance,"
          ]
        },
        {
          "type": "text",
          "content": "image-registry, message, billing, reporting) POSTs its events to the platform ingest POST /audit/events through the shared RemoteAuditClient (packages/api-core/src/services/remote-audit-client.ts)."
        },
        {
          "type": "list",
          "items": [
            "Registry structured logs — image-registry ALSO emits eventCategory: 'audit'"
          ]
        },
        {
          "type": "text",
          "content": "log lines to Loki for a couple of registry operations (see Registry structured-log events)."
        },
        {
          "type": "text",
          "content": "Both emitter paths funnel through one appender (appendAuditEvent in platform/src/helpers/audit-chain.ts), so every stored event is hash-chained and scrubbed the same way."
        },
        {
          "type": "text",
          "content": "Query the trail via GET /audit (admin-only; org admins are forced to their own org, sysadmins may filter any org) or the dashboard Audit page at /dashboard/audit. Records auto-expire via a MongoDB TTL index after config.audit.retentionDays days (default 90, overridable via AUDIT_RETENTION_DAYS)."
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "This reference explains how Pipeline Builder produces, secures, and queries its audit trail, and catalogs every action it records. It's for compliance reviewers and operators. It covers the emitter paths (platform-direct writes, the service-remote POST /audit/events ingest, and the registry's Loki structured logs), the per-tenant SHA-256 hash-chain integrity model, sensitive-data scrubbing, and the full action catalog — platform-emitted lifecycle events plus the REMOTE_AUDIT_ACTIONS subset (including billing subscription, tier, addon, and discount actions). The catalog stays in sync with the AuditAction union in code; see Adding a new audit event to extend it."
        }
      ]
    },
    {
      "id": "integrity-tamper-evidence",
      "title": "Integrity & tamper-evidence",
      "blocks": [
        {
          "type": "text",
          "content": "Every event is linked into a per-tenant SHA-256 hash chain: each row stores a hash over its immutable fields plus the prevHash of the previous event in the same chain (chain key = affectedOrgId ?? orgId). Altering, reordering, or deleting a stored event breaks the chain."
        },
        {
          "type": "list",
          "items": [
            "Verify — GET /audit/verify?orgId=<id> (sysadmin-only) walks a tenant's"
          ]
        },
        {
          "type": "text",
          "content": "chain and returns { ok, brokenAt?, count }. ok:false with brokenAt set means the chain is broken at that event. The dashboard Audit page surfaces this as a Verify integrity action for sysadmins."
        },
        {
          "type": "list",
          "items": [
            "Retention-aware — verify anchors on the first surviving event's"
          ]
        },
        {
          "type": "text",
          "content": "prevHash, so an org older than the retention window (whose genesis rows have aged out under the TTL) does not false-alarm. Tampering with any event that still has a surviving successor is detected; truncation of the oldest contiguous prefix is indistinguishable from normal TTL pruning."
        },
        {
          "type": "list",
          "items": [
            "occurredAt — events carry an occurredAt (when the action really"
          ]
        },
        {
          "type": "text",
          "content": "happened), stored for reviewers. It is deliberately not the chain-ordering field — the chain orders by ingest createdAt — so a delayed/spooled delivery never perturbs chain consistency or verification."
        },
        {
          "type": "text",
          "content": "Sensitive-data scrubbing"
        },
        {
          "type": "text",
          "content": "appendAuditEvent runs scrubAwsIdentifiers() over every event's details before hashing and storing, redacting AWS-account-id-shaped tokens (including the account segment of any ARN) and account-named keys. An AWS account id is never persisted — orgId is the marketplace customerIdentifier, never an AWS account id. Emitters must also keep secrets/tokens out of details; the frontend applies a second redaction pass before rendering or exporting."
        }
      ]
    },
    {
      "id": "service-remote-ingest-post-audit-events",
      "title": "Service-remote ingest (POST /audit/events)",
      "blocks": [
        {
          "type": "text",
          "content": "Non-platform services deliver events through RemoteAuditClient, which is best-effort and fire-and-forget — a failed audit never blocks or fails the originating mutation. Three properties make it safe and durable:"
        },
        {
          "type": "list",
          "items": [
            "Anti-forgery subset lock — the ingest authenticates the caller as a service"
          ]
        },
        {
          "type": "text",
          "content": "principal (requireServiceAuth) and validates action against the REMOTE_AUDIT_ACTIONS allow-list (isRemoteAuditAction), not the full platform AuditAction union. A service token therefore cannot forge platform-authority events (admin.superadmin.grant, org.ownership.transfer, user.login, …). A REMOTE_AUDIT_ACTIONS ⊆ AuditAction test guards drift."
        },
        {
          "type": "list",
          "items": [
            "Idempotent — each emission carries a stable Idempotency-Key; the ingest"
          ]
        },
        {
          "type": "text",
          "content": "dedups on it (unique index), so a retried delivery collapses to a single stored row and a single chain link."
        },
        {
          "type": "list",
          "items": [
            "Durable spool — if the platform is down past the client's retry budget, the"
          ]
        },
        {
          "type": "text",
          "content": "event is buffered in a bounded Redis spool (packages/api-core/src/services/audit-spool.ts) and re-delivered on recovery instead of being lost. The spool drops the OLDEST on overflow (with a metric) so it can never grow unbounded. A spooled event reuses its Idempotency-Key, so a live attempt and its later re-delivery dedup to one row."
        },
        {
          "type": "text",
          "content": "Observability — audit loss is metered, not just logged: audit_emitted_total, audit_dropped_total, audit_spool_{enqueued,dropped,redelivered}_total."
        }
      ]
    },
    {
      "id": "action-catalog",
      "title": "Action catalog",
      "blocks": [
        {
          "type": "text",
          "content": "The full set of platform actions lives in the AuditAction union in platform/src/models/audit-event.ts; the subset a remote service may emit is REMOTE_AUDIT_ACTIONS in packages/api-core/src/services/remote-audit-client.ts."
        },
        {
          "type": "text",
          "content": "Platform-emitted"
        },
        {
          "type": "table",
          "headers": [
            "Area",
            "Actions"
          ],
          "rows": [
            [
              "User lifecycle",
              "user.register, user.login, user.login.failed, user.logout, user.delete, user.profile.update, user.password.change, user.email.verified, user.token.create, user.tokens.revoke-all"
            ],
            [
              "Organization",
              "org.create, org.update, org.soft_delete, org.restore, org.switch, org.member.add, org.member.remove, org.member.deactivate, org.member.activate, org.ownership.transfer"
            ],
            [
              "Invitations",
              "invitation.send, invitation.accept, invitation.revoke, invitation.resend"
            ],
            [
              "Permission roles",
              "org.role.create, org.role.update, org.role.delete, org.role.member.add, org.role.member.remove"
            ],
            [
              "Dashboards & alerts",
              "dashboard.create/update/delete/clone, alert.destination.create/update/delete/test, alert.rule.create/update/delete"
            ],
            [
              "Admin / sysadmin",
              "admin.user.create/update/delete, admin.org.delete, admin.org.export, admin.org-idp.upsert/delete, admin.superadmin.grant/revoke, admin.org.kms-config.upsert/delete, org.kms.orphaned, admin.org.tier.update, admin.org.seatLimit.update, admin.org.quota.override, admin.org.ai-config.update, admin.user.features.update, admin.impersonate.start, admin.org.namespace.render"
            ],
            [
              "Denied access",
              "authz.denied — emitted by the shared permission gate when a state-changing (non-GET) request is rejected, so probing / privilege-escalation attempts leave a trail (outcome: 'failure')"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Each record carries actorId/actorEmail, orgId (the actor's own org), and affectedOrgId (the org actually operated on). They diverge when a sysadmin acts on another org, so the trail answers \"what did a sysadmin do to org X?\" — SOC2 evidence for impersonation-style access. admin.* actions and admin.impersonate.start set affectedOrgId to the target org so the affected org's own admins can see them."
        },
        {
          "type": "text",
          "content": "Service-emitted (REMOTE_AUDIT_ACTIONS)"
        },
        {
          "type": "table",
          "headers": [
            "Service",
            "Actions"
          ],
          "rows": [
            [
              "Plugin",
              "plugin.build.completed, plugin.build.failed, plugin.build.timeout, plugin.delete, plugin.upload, plugin.deploy, plugin.bulk.update, plugin.bulk.delete, plugin.dlq.purge"
            ],
            [
              "Pipeline",
              "pipeline.create, pipeline.update, pipeline.delete, pipeline.restore, pipeline.purge, pipeline.execution.start, pipeline.execution.cancel, pipeline.registry.register, pipeline.registry.deregister"
            ],
            [
              "Pipeline templates",
              "pipeline_template.create, pipeline_template.update, pipeline_template.delete, pipeline_template.restore, pipeline_template.purge (own action family, gated by templates:* rather than pipelines:*; create/update details carry the template's visibility rung)"
            ],
            [
              "Quota",
              "quota.reset, quota.limit.update, quota.delete"
            ],
            [
              "Compliance",
              "compliance.exemption.approve, compliance.exemption.revoke, compliance.rule.toggle, compliance.rule.create/update/delete, compliance.policy.create/update/delete, compliance.scan-schedule.create/update/delete, compliance.template.apply, compliance.scan.cancel"
            ],
            [
              "Image registry",
              "registry.gc, registry.image.delete"
            ],
            [
              "Message",
              "message.announcement.create, message.delete (admin broadcasts + deletes only — 1:1 messages are not audited, and no message body reaches details)"
            ],
            [
              "Billing",
              "billing.subscription.cancel, billing.subscription.delete, billing.tier.override, billing.addon.add, billing.addon.remove, billing.addon.prune, billing.discount.generate, billing.discount.issue, billing.discount.apply, billing.discount.remove, billing.discount.revoke, billing.credit.consumed, billing.credit.exhausted, billing.combo.expired (mirrored to the central trail alongside the service-local billing_events; details carry plan/tier/addon/discount/combo ids + cents only — never payment secrets, coupon tokens, or signing keys)"
            ],
            [
              "Ask (assistant)",
              "ask.query (read-only how-to turn), ask.agent.turn (tool-calling turn) — one per turn on POST /ask, /ask/stream, /ask/agent/stream respectively; both carry an outcome (success/failure, incl. client-abort) and details with SAFE METADATA ONLY (tools used, proposal kinds, source count, query length) — never the raw query text. Confirmed drafts commit through the normal create routes, so the resource itself is audited as pipeline.create / pipeline_template.create / plugin.deploy"
            ],
            [
              "(all services)",
              "authz.denied"
            ]
          ]
        },
        {
          "type": "note",
          "content": "Plugin build terminal outcome — plugin.build.failed / plugin.build.timeout is emitted at TRUE dead-letter-queue exhaustion, not at the tier queue's final attempt. A job that fails the tier queue but later succeeds in the DLQ emits only plugin.build.completed — the trail records exactly one terminal outcome per build, never a \"failed\" that a later \"completed\" contradicts."
        }
      ]
    },
    {
      "id": "registry-structured-log-events",
      "title": "Registry structured-log events",
      "blocks": [
        {
          "type": "text",
          "content": "Independently of the Mongo trail, image-registry emits eventCategory: 'audit' structured log lines (via emitAudit in packages/api-core/src/utils/audit.ts) that the log aggregator (Loki, in the default deploy) routes into a dedicated stream. The event-name union is packages/api-core/src/types/audit-events.ts."
        },
        {
          "type": "text",
          "content": "Querying"
        },
        {
          "type": "text",
          "content": "From the UI, two admin surfaces read the MongoDB audit trail, both scoped the same way: an org admin sees events where their org was the actor's org (orgId) or the affected org (affectedOrgId); a system admin sees every org; plain members see neither."
        },
        {
          "type": "list",
          "items": [
            "Audit Log (/dashboard/audit) — the searchable, paginated list with the"
          ]
        },
        {
          "type": "text",
          "content": "integrity (/audit/verify) check."
        },
        {
          "type": "list",
          "items": [
            "Audit Activity dashboard (/dashboard/observability/audit-activity) —"
          ]
        },
        {
          "type": "text",
          "content": "events over time by type, top actors (24h), and recent events. Its catalog entries (audit_* in platform/src/observability/catalog.ts) use the audit-store source and are orgScoped + adminOnly, so the observability API applies the same predicate as GET /audit (buildAuditQuery in platform/src/services/audit-service.ts)."
        },
        {
          "type": "text",
          "content": "The cross-service emitAudit lines described above also land in Loki with service_name, eventCategory, event, actor, and pluginName promoted to labels, searchable from the Logs page. They carry no org label, so they are not a tenant-scoped surface. Deep-link to a filtered Audit Activity view via the registry's buildAuditLogLink helper (frontend/src/lib/registry-audit-link.ts)."
        },
        {
          "type": "text",
          "content": "Direct LogQL (hitting Loki at port 3100):"
        },
        {
          "type": "code",
          "content": "{service_name=\"pipeline-image-registry\", eventCategory=\"audit\", event=\"registry.tag.copy\"}\n  | json\n  | isPromotionToSystem=`true`",
          "language": "logql"
        },
        {
          "type": "text",
          "content": "registry.tag.copy"
        },
        {
          "type": "text",
          "content": "Emitted by image-registry's POST /api/images/copy after a successful cross-repo tag copy."
        },
        {
          "type": "table",
          "headers": [
            "Field",
            "Type",
            "Description"
          ],
          "rows": [
            [
              "event",
              "'registry.tag.copy'",
              "Constant discriminator"
            ],
            [
              "actor",
              "string",
              "req.user.sub of the sysadmin who initiated the copy"
            ],
            [
              "source",
              "string",
              "Source <repo>:<ref>"
            ],
            [
              "target",
              "string",
              "Target <repo>:<ref>"
            ],
            [
              "sourceDigest",
              "string",
              "Resolved digest of the source manifest"
            ],
            [
              "targetDigest",
              "string",
              "Resolved digest of the target manifest"
            ],
            [
              "isPromotionToSystem",
              "boolean",
              "true when the target repo starts with system/ — the highest-privilege case"
            ],
            [
              "mounted.manifests",
              "number",
              "Total manifests PUT"
            ],
            [
              "mounted.blobs",
              "number",
              "Count of UNIQUE blob digests cross-mounted"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Why isPromotionToSystem matters: copying any tag into system/* makes the image visible to every authenticated user. Operators should alert on these specifically — they're meaningful trust escalations."
        },
        {
          "type": "text",
          "content": "registry.tag.delete"
        },
        {
          "type": "text",
          "content": "Emitted by image-registry's DELETE /api/images/{name}/manifests/{reference} after a successful delete."
        },
        {
          "type": "table",
          "headers": [
            "Field",
            "Type",
            "Description"
          ],
          "rows": [
            [
              "event",
              "'registry.tag.delete'",
              "Constant discriminator"
            ],
            [
              "actor",
              "string",
              "req.user.sub of the sysadmin who initiated the delete"
            ],
            [
              "repo",
              "string",
              "Repository name (e.g. org-acme/foo)"
            ],
            [
              "ref",
              "string",
              "Tag or digest the operator passed in"
            ],
            [
              "digest",
              "string",
              "Resolved manifest digest that was actually deleted"
            ]
          ]
        }
      ]
    },
    {
      "id": "adding-a-new-audit-event",
      "title": "Adding a new audit event",
      "blocks": [
        {
          "type": "text",
          "content": "Platform-emitted (user/org lifecycle):"
        },
        {
          "type": "list",
          "items": [
            "Add the action to the AuditAction union AND the ALL_AUDIT_ACTIONS array in"
          ]
        },
        {
          "type": "text",
          "content": "platform/src/models/audit-event.ts."
        },
        {
          "type": "list",
          "items": [
            "Call audit(req, 'new.action', { targetType, targetId, affectedOrgId, details })"
          ]
        },
        {
          "type": "text",
          "content": "from the controller after the mutation succeeds. Keep secrets / tokens / AWS account ids out of details."
        },
        {
          "type": "list",
          "items": [
            "Document it in the action catalog above."
          ]
        },
        {
          "type": "text",
          "content": "Service-emitted (a non-platform service):"
        },
        {
          "type": "list",
          "items": [
            "Add the action to REMOTE_AUDIT_ACTIONS in"
          ]
        },
        {
          "type": "text",
          "content": "remote-audit-client.ts AND to the platform AuditAction union / ALL_AUDIT_ACTIONS (the subset-guard test enforces REMOTE_AUDIT_ACTIONS ⊆ AuditAction)."
        },
        {
          "type": "list",
          "items": [
            "Emit it via the service's getAuditClient().record({ action, actorId, orgId, targetId, details }, '<service>') after the mutation succeeds.",
            "Document it in the service-emitted catalog above."
          ]
        },
        {
          "type": "text",
          "content": "Use the dot-separated <area>.<entity>.<verb> naming convention so events sort and filter cleanly."
        }
      ]
    }
  ],
  "sourceDoc": "docs/audit-events.md"
};
