// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Document } from 'mongoose';
import { config } from '../config/index.js';

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
  // Owner/admin self-serve org identity edit (name/slug). `affectedOrgId` is
  // the org changed; `details` carries the fields that were updated.
  | 'org.update'
  // Org SOFT-DELETE / restore lifecycle (controllers/organization.ts).
  // `org.soft_delete` is emitted when a sysadmin runs DELETE — the org enters
  // its retention window (snapshot taken, sessions cut) instead of being
  // hard-deleted; `details` carries the `purgeAfter` deadline. `org.restore`
  // reverses it within the window. The eventual hard delete is still the
  // `admin.org.delete` event emitted by the purge sweep.
  | 'org.soft_delete'
  | 'org.restore'
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
  // Permission-role assignment mutations (controllers/organization-roles.ts).
  // `affectedOrgId` is the org; `targetId` is the user added/removed; `details`
  // carries the role name + the coarse role it grants. Adding to Admin or
  // Super Admin is a privilege escalation, so these are surfaced distinctly.
  | 'org.role.member.add'
  | 'org.role.member.remove'
  | 'org.role.create'
  | 'org.role.update'
  | 'org.role.delete'
  // Admin actions (controllers/user-admin.ts)
  | 'admin.user.create'
  // Admin edit of ANOTHER user via PUT /users/:id — role/email/password/org
  // changes. `details.changes` carries the field NAMES that changed (never the
  // password value or any secret); `affectedOrgId` is the target's org. A
  // privileged account-takeover (admin resets a victim's password / elevates
  // their role) must leave this trail.
  | 'admin.user.update'
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
  | 'alert.destination.test'
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
  // Emitted by the org-delete cascade when the deleted org had a per-org KMS
  // CMK (`kmsConfig`). Auto-deleting a CMK is IRREVERSIBLE, so the cascade
  // does NOT schedule the key for deletion — it records this operator-
  // actionable event (with the org id + key identifier in `details`) so an
  // operator can manually schedule the external AWS key's deletion. Without
  // it the key (and anything wrapped under it) silently orphans.
  | 'org.kms.orphaned'
  // Org tier change. Emitted when a sysadmin moves an org between
  // pricing tiers (developer/pro/team/enterprise); reseeds quota limits as a
  // side-effect. `details` carries the previousTier so the transition
  // is reconstructable from the audit log alone.
  | 'admin.org.tier.update'
  // Account seat-limit / entitlement sync on the org root (from billing or a
  // sysadmin). `details` carries the new seat cap (+ any feature bundles).
  | 'admin.org.seatLimit.update'
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
  // Plugin builds — emitted by the plugin build worker
  // (api/plugin/src/queue/plugin-build-queue.ts) and posted to the
  // `POST /audit/events` ingest endpoint on platform, which authenticates
  // the worker via service-to-service JWT and persists them here.
  | 'plugin.build.completed'
  | 'plugin.build.failed'
  | 'plugin.build.timeout'
  // Pipeline mutations — emitted by api/pipeline's route handlers and posted
  // to the `POST /audit/events` ingest (authenticated via service-to-service
  // JWT). `targetId` is the pipeline id; `orgId` is the caller's org.
  // create/update/delete cover the CRUD surface; execution.start /
  // execution.cancel are the AWS CodePipeline run/cancel path (highest value —
  // they drive real infra actions).
  | 'pipeline.create'
  | 'pipeline.update'
  | 'pipeline.delete'
  | 'pipeline.execution.start'
  | 'pipeline.execution.cancel'
  // Plugin lifecycle mutations (api/plugin) — the delete/upload/deploy surface
  // that complements the already-audited builds. Posted to the ingest.
  | 'plugin.delete'
  | 'plugin.upload'
  | 'plugin.deploy'
  // Quota administration (api/quota) — superadmin usage-counter reset and tier
  // limit edits. `affectedOrgId` is the org changed.
  | 'quota.reset'
  | 'quota.limit.update'
  // Compliance rule administration (api/compliance) — exemption approval, rule
  // active toggle, and scan cancellation.
  | 'compliance.exemption.approve'
  | 'compliance.rule.toggle'
  | 'compliance.scan.cancel'
  // Image-registry destructive ops (api/image-registry) — GC sweeps + explicit
  // image/tag deletes.
  | 'registry.gc'
  | 'registry.image.delete'
  // Denied authorization attempt — best-effort emission from the shared
  // requirePermission / requireSystemAdmin gate on a rejected state-changing
  // request (probing/escalation signal). `outcome` is 'failure'.
  | 'authz.denied'
  // Platform admin mutations that were previously unaudited (controllers).
  // `admin.org.ai-config.update` — org AI-provider config (holds provider API
  //   keys; details carry field NAMES only, never a key value).
  // `admin.org.quota.override` — a sysadmin manual quota limit/usage override.
  // `admin.user.features.update` — a sysadmin editing a user's feature overrides.
  | 'admin.org.ai-config.update'
  | 'admin.org.quota.override'
  | 'admin.user.features.update';

/**
 * Runtime list of every AuditAction. Kept in lockstep with the
 * compile-time union above — the `satisfies` clause makes the compiler
 * verify that every union member appears here, so adding a new action
 * to the union without updating this array is a build error.
 *
 * Used by `routes/audit.ts` to validate `POST /audit/events` ingest
 * payloads at runtime (the union itself is erased at runtime).
 */
const ALL_AUDIT_ACTIONS = [
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
  'org.update',
  'org.soft_delete',
  'org.restore',
  'org.member.add',
  'org.member.remove',
  'org.member.role.update',
  'org.member.deactivate',
  'org.member.activate',
  'org.ownership.transfer',
  'org.role.member.add',
  'org.role.member.remove',
  'org.role.create',
  'org.role.update',
  'org.role.delete',
  'admin.user.create',
  'admin.user.update',
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
  'alert.destination.test',
  'alert.rule.create',
  'alert.rule.update',
  'alert.rule.delete',
  'admin.org-idp.upsert',
  'admin.org-idp.delete',
  'admin.superadmin.grant',
  'admin.superadmin.revoke',
  'admin.org.kms-config.upsert',
  'admin.org.kms-config.delete',
  'org.kms.orphaned',
  'admin.org.tier.update',
  'admin.org.seatLimit.update',
  'admin.impersonate.start',
  'admin.org.namespace.render',
  'plugin.build.completed',
  'plugin.build.failed',
  'plugin.build.timeout',
  'pipeline.create',
  'pipeline.update',
  'pipeline.delete',
  'pipeline.execution.start',
  'pipeline.execution.cancel',
  'plugin.delete',
  'plugin.upload',
  'plugin.deploy',
  'quota.reset',
  'quota.limit.update',
  'compliance.exemption.approve',
  'compliance.rule.toggle',
  'compliance.scan.cancel',
  'registry.gc',
  'registry.image.delete',
  'authz.denied',
  'admin.org.ai-config.update',
  'admin.org.quota.override',
  'admin.user.features.update',
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
  /** Actor's per-org role at action time ('owner' | 'admin' | 'member'). */
  actorRole?: string;
  orgId?: string;
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  /** Permission role involved (org.role.* actions). Promoted out of
   *  `details` so reviewers can filter "who touched role X". Field name kept
   *  as `groupId` for audit-log backward compatibility. */
  groupId?: string;
  /** Sysadmin who initiated an impersonation session, when the actor is
   *  acting under an impersonation token. Lets reviewers unmask "viewed-as". */
  impersonatorId?: string;
  /** Did the action succeed or fail? Defaults to 'success'; failure-path
   *  call sites (login.failed, plugin.build.failed/timeout) pass 'failure'. */
  outcome?: 'success' | 'failure';
  details?: Record<string, unknown>;
  ip?: string;
  /** Client User-Agent (truncated + control-chars stripped). Forensic signal
   *  for correlating an action to a device/session. */
  userAgent?: string;
  /** Correlation id (nginx `x-request-id`, or generated). Ties the event to
   *  its HTTP request and to structured log lines for the same request. */
  requestId?: string;
  /** Distributed trace id (OpenTelemetry active span) when tracing is on.
   *  Correlates the action across services end-to-end. */
  traceId?: string;
  /** TAMPER-EVIDENCE: SHA-256 digest of this event's immutable fields plus
   *  `prevHash` (see `helpers/audit-chain.ts`). Lets a verifier detect any
   *  post-hoc mutation of a stored row. */
  hash?: string;
  /** TAMPER-EVIDENCE: the `hash` of the most recent PRIOR event in the same
   *  per-tenant chain (chain key = `affectedOrgId ?? orgId`), or `null` for the
   *  first event in a chain. A missing/re-pointed link reveals a deleted or
   *  reordered row. */
  prevHash?: string | null;
  createdAt: Date;
}

const auditEventSchema = new Schema<AuditEventDocument>( {
  action: { type: String, required: true, index: true },
  actorId: { type: String, required: true, index: true },
  actorEmail: { type: String },
  actorRole: { type: String },
  orgId: { type: String, index: true },
  affectedOrgId: { type: String, index: true },
  targetType: { type: String },
  targetId: { type: String, index: true },
  // Sparse: only group/impersonation/correlation events set these, so the
  // index skips the (vast majority of) documents that leave them unset.
  groupId: { type: String, index: { sparse: true } },
  impersonatorId: { type: String, index: { sparse: true } },
  outcome: { type: String, enum: ['success', 'failure'] },
  details: { type: Schema.Types.Mixed },
  ip: { type: String },
  userAgent: { type: String },
  requestId: { type: String, index: { sparse: true } },
  traceId: { type: String },
  // TAMPER-EVIDENCE hash chain (see helpers/audit-chain.ts). Deliberately NOT
  // `required`: the append path is best-effort, so a hash/chain failure must
  // still be able to write the row rather than reject it. The tail lookup that
  // reads the chain's newest hash is served by the existing
  // `{ affectedOrgId: 1, createdAt: -1 }` compound index below (the stored
  // `affectedOrgId` always equals the chain key), so no extra index is needed.
  hash: { type: String },
  prevHash: { type: String, default: null },
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

// TTL index — auto-delete events after `config.audit.retentionDays` days
// (default 90, overridable via AUDIT_RETENTION_DAYS at boot). Reading from
// `config` keeps the env-parse in one place.
auditEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: config.audit.retentionDays * 86400 },
);

export default model<AuditEventDocument>('AuditEvent', auditEventSchema);
