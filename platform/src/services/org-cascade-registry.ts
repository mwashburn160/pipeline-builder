// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WHAT the org teardown covers: the declarative registry of every Postgres
 * table and Mongo collection an org owns data in.
 *
 * Kept apart from `org-cascade-service` (which is HOW the teardown runs) for
 * one reason: this list is the thing that drifts. A new org-scoped table or
 * collection has to be added here or the org's rows outlive the org, so the
 * registry is what the reflection drift-guards in
 * `test/org-cascade-service.test.ts` assert against — and it reads as a list
 * rather than as a detail of the sweep's control flow.
 *
 * ONE registry drives BOTH the destructive sweep and the read-only export, so
 * the soft-delete recovery snapshot and the GDPR portability artifact can never
 * silently omit a store the cascade removes.
 */

import { schema } from '@pipeline-builder/pipeline-data';
import type { Types } from 'mongoose';
import { toOrgId } from '../helpers/org-id.js';
import IdpGroupMapping from '../models/idp-group-mapping.js';
import ImpersonationRequest from '../models/impersonation-request.js';
import Invitation from '../models/invitation.js';
import JoinRequest from '../models/join-request.js';
import MfaResetRequest from '../models/mfa-reset-request.js';
import OrgDomain from '../models/org-domain.js';
import OrgIdpConfig from '../models/org-idp-config.js';
import PersonalAccessToken from '../models/personal-access-token.js';
import RoleAssignment from '../models/role-assignment.js';
import Role from '../models/role.js';
import SamlSession from '../models/saml-session.js';
import ServiceAccount from '../models/service-account.js';
import UserOrganization from '../models/user-organization.js';

// ---------------------------------------------------------------------------
// Table classification
// ---------------------------------------------------------------------------
//
// `SOFT_DELETE_TABLES` carry a `deleted_at` column — the cascade sets the
// timestamp instead of dropping the row, so downstream readers that filter
// by `deletedAt IS NULL` see the data disappear without losing the audit
// trail of what existed.
//
// `HARD_DELETE_TABLES` have no `deleted_at` — most are derivative records
// (events, scans, schedules) where retention provides no value once the
// owning org is gone. For GDPR the distinction doesn't matter; both
// approaches stop the data appearing in any product surface.
export const SOFT_DELETE_TABLES = [
  { table: schema.plugin, name: 'plugins' },
  { table: schema.pipeline, name: 'pipelines' },
  { table: schema.pipelineTemplate, name: 'pipeline_templates' },
  { table: schema.message, name: 'messages' },
  { table: schema.compliancePolicy, name: 'compliance_policies' },
  { table: schema.complianceRule, name: 'compliance_rules' },
  { table: schema.dashboard, name: 'dashboards' },
  { table: schema.orgAlertDestination, name: 'org_alert_destinations' },
  { table: schema.orgAlertRule, name: 'org_alert_rules' },
] as const;

export const HARD_DELETE_TABLES = [
  { table: schema.pipelineRegistry, name: 'pipeline_registry' },
  { table: schema.pipelineEvent, name: 'pipeline_events' },
  // DORA / reporting tables — all org-scoped (`org_id`), none carry a
  // `deleted_at`, so they are hard-removed with the org. Without them the
  // purge orphaned per-org DORA outcome markers, incidents, ingest-health rows
  // and the per-org DORA settings override.
  { table: schema.deploymentOutcome, name: 'deployment_outcomes' },
  { table: schema.incident, name: 'incidents' },
  { table: schema.ingestHealth, name: 'ingest_health' },
  { table: schema.doraSettings, name: 'dora_settings' },
  // Child rows of messages; no soft-delete columns of their own, so they are
  // hard-removed with the org (parity with pipeline_events). This deletes only
  // the METADATA rows — the MinIO blobs (keyed `<orgId>/...`) are reclaimed
  // separately by the cascade's HTTP DELETE to the message service
  // (`/messages/internal/org/:orgId/attachments` → `deleteAttachmentsByOrgPrefix`),
  // since platform holds no object-storage client. That call is best-effort
  // (`report.messageBlobs.ok`), so a MinIO lifecycle rule remains a sensible
  // backstop against a failed purge.
  { table: schema.messageAttachment, name: 'message_attachments' },
  { table: schema.complianceRuleHistory, name: 'compliance_rule_history' },
  { table: schema.complianceAuditLog, name: 'compliance_audit_log' },
  { table: schema.complianceExemption, name: 'compliance_exemptions' },
  { table: schema.complianceRuleSubscription, name: 'compliance_rule_subscriptions' },
  { table: schema.complianceScan, name: 'compliance_scans' },
  { table: schema.complianceScanSchedule, name: 'compliance_scan_schedules' },
  { table: schema.complianceNotificationPreference, name: 'compliance_notification_preferences' },
  { table: schema.complianceNotificationLog, name: 'compliance_notification_log' },
  { table: schema.complianceRole, name: 'compliance_roles' },
  { table: schema.complianceReport, name: 'compliance_reports' },
  { table: schema.complianceReportSchedule, name: 'compliance_report_schedules' },
  // Plugin ecosystem, org-scoped half: the org's step manifests, installs,
  // consumption policy and advisory-delivery ledger. The instance-wide
  // directory tables (publishers, listings, reviews, …) carry no org_id and are
  // deliberately NOT here: a publisher and its listed versions outlive the org
  // (listings go `unmaintained`, installed versions keep resolving).
  { table: schema.pipelineStepManifest, name: 'pipeline_step_manifests' },
  { table: schema.pluginInstall, name: 'plugin_installs' },
  { table: schema.pluginInstallPolicy, name: 'plugin_install_policies' },
  { table: schema.pluginAdvisoryDelivery, name: 'plugin_advisory_deliveries' },
  // The org's plugin security notification settings (webhook secret and
  // external address are encrypted under the org's own key).
  { table: schema.pluginSecurityNotificationPref, name: 'plugin_security_notification_prefs' },
] as const;

/** Every DB table name the org cascade covers (soft + hard). Exported so a
 *  schema-reflection test can assert that EVERY org-scoped table is cascaded —
 *  turning "added a table, forgot the cascade" (which silently orphaned
 *  org_alert_rules + pipeline_templates) into a red test. */
export const CASCADE_TABLE_NAMES: ReadonlySet<string> = new Set(
  [...SOFT_DELETE_TABLES, ...HARD_DELETE_TABLES].map((t) => t.name),
);

// ---------------------------------------------------------------------------
// Mongo collections the org teardown covers
// ---------------------------------------------------------------------------

/** One Mongo collection the org teardown removes, and how to read its rows. */
export interface MongoCascadeCollection<N extends string = string> {
  /** Key under `report.mongo` / `export.mongo`. */
  readonly name: N;
  /** Every row belonging to the org — what the export/snapshot must capture. */
  readonly read: (orgId: string) => Promise<unknown[]>;
  /**
   * Remove them, returning the row count. ABSENT means the rows are dropped by
   * `organizationService.delete` (the purge's own transaction) instead of here
   * — they are still the org's data, so they are still exported.
   */
  readonly remove?: (orgId: string) => Promise<number>;
}

/** Service-account ids owned by `orgId` — the key/assignment rows hang off these. */
async function serviceAccountIds(orgId: string): Promise<Types.ObjectId[]> {
  const docs = await ServiceAccount.find({ organizationId: toOrgId(orgId) }).select('_id').lean();
  return docs.map((d) => d._id);
}

/**
 * `AuditEvent` is the one collection not in this table: it is archived in fixed
 * batches and exported under a cap, both of which need their own handling —
 * {@link CASCADE_MONGO_COLLECTION_NAMES} includes it all the same.
 */
const COLLECTION_DEFS = [
  {
    name: 'invitations',
    read: (orgId) => Invitation.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await Invitation.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    name: 'idpConfigs',
    read: (orgId) => OrgIdpConfig.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await OrgIdpConfig.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    name: 'idpGroupMappings',
    read: (orgId) => IdpGroupMapping.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await IdpGroupMapping.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    name: 'orgDomains',
    read: (orgId) => OrgDomain.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await OrgDomain.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    name: 'joinRequests',
    read: (orgId) => JoinRequest.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await JoinRequest.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // SAML SLO bookkeeping (one row per platform session a SAML sign-in
    // opened). TTL-expiring, but the rows are org-scoped: without this leg a
    // purged org's rows sat in the collection until their refresh window
    // lapsed, and the SLO endpoint kept matching them.
    name: 'samlSessions',
    read: (orgId) => SamlSession.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await SamlSession.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // Members' PERSONAL keys (`pb_pat`) minted against this org. Their tokens
    // are scoped to the org, so once it is gone a surviving key is a live
    // credential pointing at nothing — and `createdIp` / `createdUserAgent` are
    // the member's personal data. Service-account keys are the SA leg's.
    // `keyHash` is the stored secret — never in an artifact.
    name: 'personalAccessTokens',
    read: (orgId) => PersonalAccessToken.find({ userId: { $ne: null }, organizationId: toOrgId(orgId) })
      .select('-keyHash').lean(),
    remove: async (orgId) => (await PersonalAccessToken.deleteMany({ userId: { $ne: null }, organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // Two-person MFA-reset requests raised inside the org (requester,
    // approver and target identities + reasons).
    name: 'mfaResetRequests',
    read: (orgId) => MfaResetRequest.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await MfaResetRequest.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // Consent-gated impersonation requests targeting the org's members.
    name: 'impersonationRequests',
    read: (orgId) => ImpersonationRequest.find({ organizationId: toOrgId(orgId) }).lean(),
    remove: async (orgId) => (await ImpersonationRequest.deleteMany({ organizationId: toOrgId(orgId) })).deletedCount ?? 0,
  },
  {
    // Removed (with its keys and Role assignments) by the cascade's
    // service-account leg, which reports BOTH counts — hence no `remove` here.
    name: 'serviceAccounts',
    read: (orgId) => ServiceAccount.find({ organizationId: toOrgId(orgId) }).lean(),
  },
  {
    // `keyHash` is the stored form of the secret — never put it in an artifact
    // handed to an operator or a tenant.
    name: 'serviceAccountKeys',
    read: async (orgId) => {
      const ids = await serviceAccountIds(orgId);
      if (ids.length === 0) return [];
      return PersonalAccessToken.find({ serviceAccountId: { $in: ids } })
        .select('-keyHash').lean();
    },
  },
  // The three below are removed by `organizationService.delete` (one
  // transaction, after this cascade), so they carry no `remove` — but without
  // them a restored org has no members and no Roles.
  {
    name: 'memberships',
    read: (orgId) => UserOrganization.find({ organizationId: toOrgId(orgId) }).lean(),
  },
  {
    name: 'roleAssignments',
    read: (orgId) => RoleAssignment.find({ organizationId: toOrgId(orgId) }).lean(),
  },
  {
    name: 'roles',
    read: (orgId) => Role.find({ organizationId: toOrgId(orgId) }).lean(),
  },
] as const satisfies readonly MongoCascadeCollection[];

/** Every Mongo collection the teardown covers, by its report/export key. */
export type CascadeMongoName = (typeof COLLECTION_DEFS)[number]['name'] | 'auditEvents';

export const MONGO_CASCADE_COLLECTIONS: readonly MongoCascadeCollection<CascadeMongoName>[] = COLLECTION_DEFS;

/**
 * The collections the cascade itself deletes from, and so counts in
 * `report.mongo`: those with a `remove`, the service-account leg (accounts +
 * their keys) and the archived audit chain. Memberships, Role assignments and
 * Roles go with `organizationService.delete` and are counted there.
 */
type RemovableDef = Extract<(typeof COLLECTION_DEFS)[number], { remove: unknown }>;
export type CascadeRemovedName = RemovableDef['name'] | 'serviceAccounts' | 'serviceAccountKeys' | 'auditEvents';

/** The collections whose rows the cascade deletes itself. */
export const MONGO_REMOVABLE: readonly RemovableDef[] = COLLECTION_DEFS.filter((c): c is RemovableDef => 'remove' in c);

/**
 * Every Mongo collection the org teardown removes. Exported so a reflection
 * test can assert each one appears in the export artifact — the Mongo twin of
 * {@link CASCADE_TABLE_NAMES}.
 */
export const CASCADE_MONGO_COLLECTION_NAMES: ReadonlySet<string> = new Set([
  ...MONGO_CASCADE_COLLECTIONS.map((c) => c.name),
  'auditEvents',
]);
