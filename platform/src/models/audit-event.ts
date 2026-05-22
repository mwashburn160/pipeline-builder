// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document } from 'mongoose';

/**
 * Audit event action categories.
 *
 * Only includes actions actually emitted by `helpers/audit.ts` callers today.
 * Add a value here AND wire the corresponding `audit(req, '<name>',...)`
 * call in the controller  declaring the value alone produces a dead surface
 * that misleads dashboard filters.
 */
export type AuditAction =
  // User lifecycle (controllers/auth.ts, controllers/user-profile.ts)
  | 'user.register'
  | 'user.login'
  | 'user.login.failed'
  | 'user.logout'
  | 'user.delete'
  | 'user.profile.update'
  | 'user.password.change'
  | 'user.token.create'
  | 'user.tokens.revoke-all'
  // Organization (controllers/organization.ts)
  | 'org.create'
  // Organization membership mutations (controllers/organization-members.ts).
  // `affectedOrgId` carries the org being mutated; `targetId` is the user
  // being added/removed/modified. Privilege changes are surfaced separately
  // from the per-org operations so reviewers can filter on "who became owner
  // of what, when".
  | 'org.member.add'
  | 'org.member.remove'
  | 'org.member.role.update'
  | 'org.member.deactivate'
  | 'org.member.activate'
  | 'org.ownership.transfer'
  // Admin actions (controllers/user-admin.ts)
  | 'admin.user.delete'
  | 'admin.org.delete'
  // GDPR portability export. Emitted from controllers/organization.ts
  // when a sysadmin downloads an org's full data dump (before deletion or
  // on customer request).
  | 'admin.org.export'
  // Dashboards (controllers/dashboards.ts)
  | 'dashboard.create'
  | 'dashboard.update'
  | 'dashboard.delete'
  | 'dashboard.clone'
  // Alert destinations (controllers/alert-destinations.ts)
  | 'alert.destination.create'
  | 'alert.destination.update'
  | 'alert.destination.delete'
  // per-org operator-authored alert rules (controllers/alert-rules.ts).
  | 'alert.rule.create'
  | 'alert.rule.update'
  | 'alert.rule.delete'
  // per-org IdP config (controllers/org-idp.ts). Sysadmin-only setup.
  | 'admin.org-idp.upsert'
  | 'admin.org-idp.delete'
  // Sysadmin authority grants/revokes. The bootstrap path
  // (BOOTSTRAP_SUPERADMIN_EMAILS) emits `grant`; the admin endpoint emits
  // both. `actorId='bootstrap-env'` for env-driven promotions — operators
  // reading the audit log can tell at a glance whether sysadmin authority
  // was granted by an interactive flow (actorId is a user) or by deploy-
  // time configuration.
  | 'admin.superadmin.grant'
  | 'admin.superadmin.revoke'
  // Per-org KMS config admin endpoint. `upsert` covers both first set and
  // rotation; `delete` clears the config and reverts the org to the shared
  // master fallback. Both emit `affectedOrgId` for cross-org filtering.
  | 'admin.org.kms-config.upsert'
  | 'admin.org.kms-config.delete'
  // Org tier change. Emitted when a sysadmin moves an org between
  // pricing tiers (developer/pro/unlimited); reseeds quota limits as a
  // side-effect. `details` carries the previousTier so the transition
  // is reconstructable from the audit log alone.
  | 'admin.org.tier.update'
  // Sysadmin impersonation. `admin.impersonate.start` is emitted when
  // a read-only impersonation token is issued; the `impersonatorId` in
  // details + `targetId` (the impersonated user) tell reviewers who
  // viewed-as-whom. Read-only — no destructive actions can land under
  // the impersonation token, so a single "start" event covers the
  // session (no stop event needed; the token TTL bounds the window).
  | 'admin.impersonate.start'
  // Per-org k8s namespace manifest render. Operator-driven provisioning
  // for enterprise-tier customers — emitted whenever a sysadmin downloads
  // the namespace YAML to apply with kubectl. Tracks "this org got its
  // own namespace at <time> by <sysadmin>".
  | 'admin.org.namespace.render'
  // Plugin builds  emitted by the plugin build worker (api/plugin/src/queue/plugin-build-queue.ts).
  // Today these are surfaced via Loki only (the per-plugin drill-down
  // dashboard reads them); MongoDB ingestion is a separate follow-up that
  // would add an internal `/audit-events` ingest endpoint on platform.
  // The action keys live here so the vocabulary is unified + type-checked
  // before that plumbing lands.
  | 'plugin.build.completed'
  | 'plugin.build.failed'
  | 'plugin.build.timeout';

/**
 * Runtime list of every AuditAction. Kept in lockstep with the
 * compile-time union above — the `satisfies` clause makes the compiler
 * verify that every union member appears here, so adding a new action
 * to the union without updating this array is a build error.
 *
 * Used by `routes/audit.ts` to validate `POST /audit/events` ingest
 * payloads at runtime (the union itself is erased at runtime).
 */
export const ALL_AUDIT_ACTIONS = [
  'user.register',
  'user.login',
  'user.login.failed',
  'user.logout',
  'user.delete',
  'user.profile.update',
  'user.password.change',
  'user.token.create',
  'user.tokens.revoke-all',
  'org.create',
  'org.member.add',
  'org.member.remove',
  'org.member.role.update',
  'org.member.deactivate',
  'org.member.activate',
  'org.ownership.transfer',
  'admin.user.delete',
  'admin.org.delete',
  'admin.org.export',
  'dashboard.create',
  'dashboard.update',
  'dashboard.delete',
  'dashboard.clone',
  'alert.destination.create',
  'alert.destination.update',
  'alert.destination.delete',
  'alert.rule.create',
  'alert.rule.update',
  'alert.rule.delete',
  'admin.org-idp.upsert',
  'admin.org-idp.delete',
  'admin.superadmin.grant',
  'admin.superadmin.revoke',
  'admin.org.kms-config.upsert',
  'admin.org.kms-config.delete',
  'admin.org.tier.update',
  'admin.impersonate.start',
  'admin.org.namespace.render',
  'plugin.build.completed',
  'plugin.build.failed',
  'plugin.build.timeout',
] as const satisfies ReadonlyArray<AuditAction>;

/** Runtime predicate: type-narrowing check used by the ingest route. */
export function isAuditAction(value: string): value is AuditAction {
  return (ALL_AUDIT_ACTIONS as ReadonlyArray<string>).includes(value);
}

/**
 * Audit event document stored in MongoDB.
 *
 * Field semantics * - `orgId`  actor's JWT-claimed org at the time of the action.
 * - `affectedOrgId`  the org that was OPERATED ON. Same as `orgId` for
 * normal in-org actions. When a sysadmin (whose `orgId`
 * is the system org) touches another org's resources,
 * `affectedOrgId` carries the impacted org so the audit
 * log answers "what did a sysadmin do to org X?".
 * Required for SOC2 evidence on impersonation-style
 * access.
 */
export interface AuditEventDocument extends Document {
  action: AuditAction;
  actorId: string;
  actorEmail?: string;
  orgId?: string;
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  createdAt: Date;
}

const auditEventSchema = new Schema<AuditEventDocument>( {
  action: { type: String, required: true, index: true },
  actorId: { type: String, required: true, index: true },
  actorEmail: { type: String },
  orgId: { type: String, index: true },
  affectedOrgId: { type: String, index: true },
  targetType: { type: String },
  targetId: { type: String, index: true },
  details: { type: Schema.Types.Mixed },
  ip: { type: String },
},
{
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'audit_events',
},
);

// Compound indexes for org-scoped queries sorted by time. Both
// `orgId` (actor's org) and `affectedOrgId` (the operated-on org) get one
//  the "what did sysadmins do to my org" query filters on affectedOrgId.
auditEventSchema.index({ orgId: 1, createdAt: -1 });
auditEventSchema.index({ affectedOrgId: 1, createdAt: -1 });

// TTL index  auto-delete events after 90 days (configurable via AUDIT_RETENTION_DAYS)
const retentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10);
auditEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: retentionDays * 86400 });

export default model<AuditEventDocument>('AuditEvent', auditEventSchema);
