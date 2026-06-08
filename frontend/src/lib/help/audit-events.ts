// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ScrollText } from 'lucide-react';
import type { HelpTopic } from './types';

export const auditEventsTopic: HelpTopic = {
  id: 'audit-events',
  title: 'Audit Events',
  description: 'How Pipeline Builder records and surfaces audit events',
  icon: ScrollText,
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'text',
          content:
            'Pipeline Builder emits audit events through two complementary paths: the Platform service writes user and organization lifecycle events directly to MongoDB, while other services emit structured log lines that the log aggregator routes into a dedicated audit stream.',
        },
      ],
    },
    {
      id: 'platform-path',
      title: 'Path 1: Platform (MongoDB-backed)',
      blocks: [
        {
          type: 'text',
          content:
            'The platform service writes user and org lifecycle events directly to its MongoDB audit_events collection via the audit() helper. These are queryable through the platform audit API (GET /audit), which is admin-only and org-scoped for org admins.',
        },
        {
          type: 'table',
          headers: ['Area', 'Example actions'],
          rows: [
            ['User lifecycle', 'user.register, user.login, user.login.failed, user.logout, user.delete'],
            ['Organization', 'org.create, org.member.add, org.member.role.update, org.ownership.transfer'],
            ['Dashboards', 'dashboard.create, dashboard.update, dashboard.delete, dashboard.clone'],
            ['Alerts', 'alert.destination.create/update/delete, alert.rule.create/update/delete'],
            ['Admin', 'admin.user.delete, admin.org.export, admin.impersonate.start, admin.org.tier.update'],
            ['Plugin builds', 'plugin.build.completed, plugin.build.failed, plugin.build.timeout'],
          ],
        },
        {
          type: 'text',
          content:
            'Each record carries an actorId/actorEmail, orgId (the actor\'s own org), and an affectedOrgId (the org actually operated on). These diverge when a sysadmin acts on another org, so the log can answer "what did a sysadmin do to org X?" — required for SOC2 evidence on impersonation-style access.',
        },
        {
          type: 'note',
          content:
            'Records auto-expire via a MongoDB TTL index after config.audit.retentionDays days (default 90, overridable via AUDIT_RETENTION_DAYS).',
        },
      ],
    },
    {
      id: 'cross-service-path',
      title: 'Path 2: Cross-service (structured logs)',
      blocks: [
        {
          type: 'text',
          content:
            'Other services emit audit events as structured log lines that the log aggregator (Loki, in the default deploy) routes into a dedicated stream. There are two categories on this path:',
        },
        {
          type: 'list',
          items: [
            "eventCategory: 'audit' — emitted by image-registry via the emitAudit helper in api-core. Detailed below.",
            "eventCategory: 'plugin-build' — emitted by the plugin build worker for plugin.build.* outcomes. Also forwarded to platform's MongoDB audit store via POST /audit/events, so they appear on both paths.",
          ],
        },
        {
          type: 'warning',
          content:
            'Audit writes are best-effort: if the logger fails, the originating mutation still succeeds. A successful operation is never rolled back because the audit write did not land.',
        },
      ],
    },
    {
      id: 'querying',
      title: 'Querying',
      blocks: [
        {
          type: 'text',
          content:
            'Audit events land in Loki with service_name, eventCategory, event, actor, and pluginName promoted to labels. Digest fields are intentionally not promoted — they are per-event unique, so labeling them would blow up Loki\'s label cardinality.',
        },
        {
          type: 'text',
          content:
            'From the UI, the Audit Activity dashboard at /dashboard/observability/audit-activity is the operator-facing surface. You can deep-link straight to a filtered view by passing event, since, and until query parameters.',
        },
        {
          type: 'code',
          language: 'logql',
          content: `{service_name="pipeline-image-registry", eventCategory="audit", event="registry.tag.copy"}
  | json
  | isPromotionToSystem=\`true\``,
        },
        {
          type: 'note',
          content:
            'Stream selectors on the promoted labels are the fast path. Anything else (e.g. isPromotionToSystem, sourceDigest) requires | json parsing.',
        },
      ],
    },
    {
      id: 'registry-events',
      title: 'Cross-service registry events',
      blocks: [
        {
          type: 'text',
          content:
            'registry.tag.copy is emitted by image-registry\'s POST /api/images/copy after a successful cross-repo tag copy. Key fields:',
        },
        {
          type: 'table',
          headers: ['Field', 'Type', 'Description'],
          rows: [
            ['actor', 'string', 'req.user.sub of the sysadmin who initiated the copy'],
            ['source', 'string', 'Source <repo>:<ref>'],
            ['target', 'string', 'Target <repo>:<ref>'],
            ['sourceDigest', 'string', 'Resolved digest of the source manifest'],
            ['isPromotionToSystem', 'boolean', 'true when the target repo starts with system/'],
            ['mounted.manifests', 'number', 'Total manifests PUT'],
            ['mounted.blobs', 'number', 'Count of unique blob digests cross-mounted'],
          ],
        },
        {
          type: 'warning',
          content:
            'Copying any tag into system/* makes the image visible to every authenticated user. Operators should alert and report on isPromotionToSystem specifically — these are meaningful trust escalations.',
        },
        {
          type: 'text',
          content:
            'registry.tag.delete is emitted by image-registry\'s DELETE /api/images/{name}/manifests/{reference} after a successful delete. It records actor, repo, ref, and the resolved digest that was actually deleted. Since Distribution deletes manifests by digest, every tag pointing to that digest becomes broken; listing affected tags is a UI-side concern.',
        },
      ],
    },
    {
      id: 'adding-events',
      title: 'Adding a new audit event',
      blocks: [
        {
          type: 'list',
          items: [
            'Add a new interface to packages/api-core/src/types/audit-events.ts and extend the AuditEvent union — the single source of truth.',
            "Call emitAudit(logger, { event: 'new.event.name', … }) from the route after the mutation succeeds.",
            'Document the event with a fields table and example.',
            'Use the dot-separated <area>.<entity>.<verb> naming convention so events sort and filter cleanly.',
          ],
        },
      ],
    },
  ],
};
