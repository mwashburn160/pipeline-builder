// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Org delete cascade + GDPR data export.
 *
 * Orchestrates the destructive sweep across every store the platform owns
 * data in for a given org * - Postgres (via pipeline-core): 21 tables with `org_id`. Soft-deleted
 * where `deleted_at` exists; hard-deleted otherwise.
 * - Mongo (platform's own): UserOrganization, Invitation, AuditEvent
 * (except the `admin.org.delete` audit event for this very action,
 * which is preserved so the audit log can prove the delete happened).
 * - Quota service: HTTP DELETE /quotas/:orgId.
 * - Billing service: HTTP DELETE /billing/subscriptions/by-org/:orgId.
 *
 * Export mirrors the cascade in read-only mode: walks the same set and
 * returns a single JSON blob the operator can hand to the org (right-to-
 * portability) before pulling the trigger.
 */

import { createLogger, createSafeClient, errorMessage, getServiceAuthHeader, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { db, runWithTenantContext, schema } from '@pipeline-builder/pipeline-data';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config/index.js';
import { toOrgId } from '../helpers/org-id.js';
import AuditEvent from '../models/audit-event.js';
import DeletedOrgSnapshot from '../models/deleted-org-snapshot.js';
import Invitation from '../models/invitation.js';
import OrgIdpConfig from '../models/org-idp-config.js';
import Organization from '../models/organization.js';
import UserOrganization from '../models/user-organization.js';
import User from '../models/user.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';

const logger = createLogger('org-cascade');

/** Cannot delete the system org. Matches the existing org-delete guard.
 *  Same string value as `services/organization-service`'s export — the
 *  controller errorMap uses that one. Kept exported because the cascade
 *  test imports this constant. */
export const SYSTEM_ORG_DELETE_FORBIDDEN = 'SYSTEM_ORG_DELETE_FORBIDDEN';
/** Thrown by {@link softDeleteOrg} when the org doesn't exist. Mapped to 404. */
export const ORG_NOT_FOUND = 'ORG_NOT_FOUND';
/** Thrown by {@link softDeleteOrg} when the org is already soft-deleted (in its
 *  retention window). Mapped to 409 — a repeat delete is a no-op the caller
 *  should see, not a silent overwrite of the original `deletedAt`/snapshot. */
export const ORG_ALREADY_DELETED = 'ORG_ALREADY_DELETED';
/** Thrown by {@link softDeleteOrg} when the recovery snapshot could not be
 *  produced or persisted. The soft-delete is ABORTED — we never tombstone an
 *  org we couldn't snapshot. Mapped to 502. */
export const ORG_SNAPSHOT_FAILED = 'ORG_SNAPSHOT_FAILED';

// ---------------------------------------------------------------------------
// Table classification
// ---------------------------------------------------------------------------
//
// `softDeleteTables` carry a `deleted_at` column  the cascade sets the
// timestamp instead of dropping the row, so downstream readers that filter
// by `deletedAt IS NULL` see the data disappear without losing the audit
// trail of what existed.
//
// `hardDeleteTables` have no `deleted_at`  most are derivative records
// (events, scans, schedules) where retention provides no value once the
// owning org is gone. For GDPR the distinction doesn't matter; both
// approaches stop the data appearing in any product surface.
const SOFT_DELETE_TABLES = [
  { table: schema.plugin, name: 'plugins' },
  { table: schema.pipeline, name: 'pipelines' },
  { table: schema.message, name: 'messages' },
  { table: schema.compliancePolicy, name: 'compliance_policies' },
  { table: schema.complianceRule, name: 'compliance_rules' },
  { table: schema.dashboard, name: 'dashboards' },
  { table: schema.orgAlertDestination, name: 'org_alert_destinations' },
] as const;

const HARD_DELETE_TABLES = [
  { table: schema.pipelineRegistry, name: 'pipeline_registry' },
  { table: schema.pipelineEvent, name: 'pipeline_events' },
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
] as const;

// ---------------------------------------------------------------------------
// HTTP clients for downstream services
// ---------------------------------------------------------------------------

/** Timeout for cascade HTTP DELETEs. Cascade is rarely-run and best-effort
 * 5s is generous; override via `ORG_CASCADE_HTTP_TIMEOUT_MS`. */
const CASCADE_HTTP_TIMEOUT_MS = parseInt(process.env.ORG_CASCADE_HTTP_TIMEOUT_MS || '5000', 10);

function quotaClient() {
  return createSafeClient({
    host: config.quota.serviceHost,
    port: config.quota.servicePort,
    timeout: CASCADE_HTTP_TIMEOUT_MS,
  });
}

function billingClient() {
  return createSafeClient({
    host: config.billing?.serviceHost ?? 'billing',
    port: config.billing?.servicePort ?? 3000,
    timeout: CASCADE_HTTP_TIMEOUT_MS,
  });
}

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

/** Per-store row counts after cascade  handy for the audit event detail.
 *  Postgres entries carry an `ok` flag + either a row count or an error
 *  message so audit consumers can distinguish "deleted 0 rows" from
 *  "delete failed" — the prior `-1` sentinel conflated the two. */
export interface CascadeReport {
  postgres: Record<string, { ok: boolean; rowCount?: number; error?: string }>;
  mongo: { invitations: number; auditEvents: number; idpConfigs: number };
  quota: { ok: boolean; statusCode?: number };
  billing: { ok: boolean; statusCode?: number };
  /** Present ONLY when the deleted org had a per-org KMS CMK (`kmsConfig`).
   *  The cascade does NOT auto-delete the external AWS key (irreversible) —
   *  it flags the orphan so an operator can schedule the key's deletion
   *  manually. `keyRef` carries the key identifier (undefined if the config
   *  stored only a wrapped master with no keyId). */
  kms?: { flagged: true; keyRef?: string };
}

/**
 * Soft- or hard-delete every row across the platform's own Postgres + Mongo
 * stores AND fire HTTP DELETEs at the quota / billing services. Returns a
 * report of what happened so the calling controller can stash it in the
 * `admin.org.delete` audit event.
 *
 * `actorOrgId` is the org of the sysadmin running the delete  needed for
 * the tenant-context scope so the soft-delete UPDATEs pass FORCE'd RLS on
 * the affected tables. Sysadmins bypass RLS via the `is_sysadmin` GUC.
 */
export async function cascadeDeleteOrg( orgId: string,
  actorOrgId: string,
): Promise<CascadeReport> {
  if (orgId === SYSTEM_ORG_ID) {
    throw new Error(SYSTEM_ORG_DELETE_FORBIDDEN);
  }

  const report: CascadeReport = {
    postgres: {},
    mongo: { invitations: 0, auditEvents: 0, idpConfigs: 0 },
    quota: { ok: false },
    billing: { ok: false },
  };

  // -- Postgres: run under sysadmin tenant context so the soft-delete UPDATEs
  // pass FORCE'd RLS without needing a per-table USING clause for the deletor.
  await runWithTenantContext({ orgId: actorOrgId, isSuperAdmin: true }, async () => {
    const now = new Date();
    for (const { table, name } of SOFT_DELETE_TABLES) {
      try {
        // Soft delete only rows not already tombstoned. The duplicate update
        // would be harmless but the row count then misreports.
        const result = await db.update(table as never)
          .set({ deletedAt: now } as never)
          .where(sql`${(table as { orgId: unknown }).orgId} = ${orgId} AND deleted_at IS NULL`);
        report.postgres[name] = { ok: true, rowCount: (result as { rowCount?: number }).rowCount ?? 0 };
      } catch (err) {
        logger.error('Postgres soft-delete failed', { table: name, orgId, error: errorMessage(err) });
        report.postgres[name] = { ok: false, error: errorMessage(err) };
      }
    }
    for (const { table, name } of HARD_DELETE_TABLES) {
      try {
        const result = await db.delete(table as never)
          .where(eq((table as { orgId: unknown }).orgId as never, orgId as never));
        report.postgres[name] = { ok: true, rowCount: (result as { rowCount?: number }).rowCount ?? 0 };
      } catch (err) {
        logger.error('Postgres hard-delete failed', { table: name, orgId, error: errorMessage(err) });
        report.postgres[name] = { ok: false, error: errorMessage(err) };
      }
    }
  });

  // -- Mongo: invitations + audit events. The `admin.org.delete` event for
  // this very action is written AFTER the cascade returns (by the caller),
  // so deleting AuditEvent here is safe  the controller's audit() call
  // lands a fresh record afterward.
  try {
    const invRes = await Invitation.deleteMany({ organizationId: orgId } as never);
    report.mongo.invitations = invRes.deletedCount ?? 0;
  } catch (err) {
    logger.error('Invitation cleanup failed', { orgId, error: errorMessage(err) });
  }

  try {
    // Match BOTH orgId (actor's org at action time) AND affectedOrgId so
    // sysadmin actions against this org (from a different actor org) also
    // get pruned. Keep the `admin.org.delete` action  it's intentionally
    // preserved as the audit trail of this very operation; the controller
    // emits a fresh one after cascade returns.
    const auditRes = await AuditEvent.deleteMany({
      $or: [{ orgId }, { affectedOrgId: orgId }],
      action: { $ne: 'admin.org.delete' },
    });
    report.mongo.auditEvents = auditRes.deletedCount ?? 0;
  } catch (err) {
    logger.error('AuditEvent cleanup failed', { orgId, error: errorMessage(err) });
  }

  // Per-org IdP config doc (separate collection — would otherwise orphan
  // and a future org reusing this id would silently inherit SSO config).
  // Sysadmin-only writes the collection, so deleting on cascade is safe.
  try {
    const idpRes = await OrgIdpConfig.deleteMany({ orgId } as never);
    report.mongo.idpConfigs = (idpRes as { deletedCount?: number }).deletedCount ?? 0;
  } catch (err) {
    logger.error('OrgIdpConfig cleanup failed', { orgId, error: errorMessage(err) });
  }

  // -- Quota service: HTTP DELETE /quotas/:orgId. Service-token auth  the
  // quota service trusts billing/platform as peer services.
  //
  // NOTE: quota + billing `ok` are HARD GATES for the caller — the org-delete
  // controller aborts the org-doc delete when either is false (a live
  // subscription must never outlive its org). We still only warn + record the
  // flag here so the cascade returns a full report; the caller decides.
  try {
    const auth = getServiceAuthHeader({ serviceName: 'platform', orgId: SYSTEM_ORG_ID, role: 'owner' });
    const resp = await quotaClient().delete(`/quotas/${encodeURIComponent(orgId)}`, {
      headers: { 'Authorization': auth, 'x-org-id': orgId },
    });
    report.quota = { ok: !!resp && resp.statusCode < 400, statusCode: resp?.statusCode };
  } catch (err) {
    logger.warn('Quota service delete failed', { orgId, error: errorMessage(err) });
  }

  // -- Billing service: HTTP DELETE /billing/subscriptions/by-org/:orgId.
  // The endpoint cancels any active subscription + drops events + dedupe
  // keys; see billing service implementation.
  try {
    const auth = getServiceAuthHeader({ serviceName: 'platform', orgId: SYSTEM_ORG_ID, role: 'owner' });
    const resp = await billingClient().delete(`/billing/subscriptions/by-org/${encodeURIComponent(orgId)}`, {
      headers: { 'Authorization': auth, 'x-org-id': orgId },
    });
    report.billing = { ok: !!resp && resp.statusCode < 400, statusCode: resp?.statusCode };
  } catch (err) {
    logger.warn('Billing service delete failed', { orgId, error: errorMessage(err) });
  }

  // -- Per-org KMS CMK: the org may have its own KMS customer master key
  // (`kmsConfig`) wrapping its secrets. Auto-deleting a CMK is IRREVERSIBLE
  // (and anything still wrapped under it becomes unrecoverable), so the
  // cascade deliberately does NOT schedule/delete the key. Instead, when a
  // per-org key exists, emit an operator-actionable signal — a distinct WARN
  // log AND an `org.kms.orphaned` audit event carrying the org id + key
  // identifier — so an operator can schedule the external AWS key deletion
  // manually. Best-effort: a lookup/audit failure here must not abort the
  // cascade (the org data is already gone), but we still surface it.
  try {
    const org = await Organization.findById(orgId).select('kmsConfig').lean();
    const kmsConfig = (org as { kmsConfig?: { keyId?: string; ciphertextBase64?: string } } | null)?.kmsConfig;
    if (kmsConfig && (kmsConfig.keyId || kmsConfig.ciphertextBase64)) {
      const keyRef = kmsConfig.keyId;
      report.kms = { flagged: true, keyRef };
      logger.warn(
        'Deleted org had a per-org KMS CMK — NOT auto-deleted (irreversible). Operator must schedule the external AWS key deletion manually.',
        { orgId, keyRef },
      );
      try {
        await AuditEvent.create({
          action: 'org.kms.orphaned',
          actorId: 'org-cascade',
          orgId: actorOrgId,
          affectedOrgId: orgId,
          targetType: 'organization',
          targetId: orgId,
          details: {
            keyId: keyRef,
            reason: 'per-org KMS CMK requires manual deletion — cascade does not auto-delete (irreversible)',
          },
        } as never);
      } catch (auditErr) {
        logger.error('Failed to record org.kms.orphaned audit event', { orgId, keyRef, error: errorMessage(auditErr) });
      }
    }
  } catch (err) {
    logger.warn('Per-org KMS lookup failed during cascade', { orgId, error: errorMessage(err) });
  }

  logger.info('Org cascade complete', { orgId, report });
  return report;
}

// ---------------------------------------------------------------------------
// Soft-delete (grace window + auto-export)
// ---------------------------------------------------------------------------

/** Result of a successful {@link softDeleteOrg}. */
export interface SoftDeleteResult {
  orgId: string;
  deletedAt: Date;
  /** When the purge sweep may run the destructive cascade. Until then the org
   *  can be restored. */
  purgeAfter: Date;
  /** Id of the durable recovery snapshot persisted before the tombstone. */
  snapshotId: string;
  /** How many active members had their sessions invalidated (tokenVersion bump). */
  membersInvalidated: number;
}

/**
 * SOFT-delete an org: capture a durable recovery snapshot, tombstone the org
 * (`deletedAt`/`purgeAfter`), and invalidate every active member's session so
 * access is cut off immediately. Runs NO destructive cascade — the purge sweep
 * ({@link import('./org-purge.js').purgeExpiredOrgs}) does that once the
 * retention window lapses.
 *
 * Ordering is safety-critical:
 *   1. Export the org (`exportOrg`) + persist it to `deleted_org_snapshots`
 *      BEFORE anything else. If either fails we throw {@link ORG_SNAPSHOT_FAILED}
 *      and the org is NOT tombstoned — we never lose an org without a snapshot.
 *   2. In one transaction: set the tombstone AND bump `tokenVersion` (+ clear
 *      refresh tokens) for every active member, mirroring removeMember/
 *      deactivateMember. The tokenVersion bump makes outstanding access tokens
 *      fail `requireAuth`; the token chokepoint (`resolveMembership`) then
 *      refuses to re-issue a token scoped to the soft-deleted org.
 *
 * `actorOrgId` is the sysadmin's own org (for the export's RLS scope);
 * `deletedBy` is the sysadmin user id (stored on the snapshot).
 *
 * Throws SYSTEM_ORG_DELETE_FORBIDDEN / ORG_NOT_FOUND / ORG_ALREADY_DELETED /
 * ORG_SNAPSHOT_FAILED — the controller maps these to HTTP status.
 */
export async function softDeleteOrg(
  orgId: string,
  actorOrgId: string,
  deletedBy: string,
): Promise<SoftDeleteResult> {
  if (orgId === SYSTEM_ORG_ID) {
    throw new Error(SYSTEM_ORG_DELETE_FORBIDDEN);
  }

  const org = await Organization.findById(toOrgId(orgId)).select('name deletedAt').lean();
  if (!org) throw new Error(ORG_NOT_FOUND);
  if ((org as { deletedAt?: Date | null }).deletedAt) throw new Error(ORG_ALREADY_DELETED);

  // 1. Recovery snapshot FIRST — abort the whole soft-delete if we can't capture
  // + persist it. Losing an org without a snapshot is the one outcome we refuse.
  let snapshotId: string;
  try {
    const snapshot = await exportOrg(orgId, actorOrgId);
    const doc = await DeletedOrgSnapshot.create({
      orgId,
      name: org.name,
      snapshot,
      deletedAt: new Date(),
      deletedBy,
    });
    snapshotId = String((doc as { _id: unknown })._id);
  } catch (err) {
    logger.error('Org soft-delete ABORTED — recovery snapshot failed; org NOT tombstoned', {
      orgId, error: errorMessage(err),
    });
    throw new Error(ORG_SNAPSHOT_FAILED);
  }

  // 2. Tombstone + session cut-off, atomically.
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + config.organization.deletionRetentionDays * 86400 * 1000);

  const membersInvalidated = await withMongoTransaction(async (session) => {
    await Organization.updateOne(
      { _id: toOrgId(orgId) },
      { $set: { deletedAt: now, purgeAfter } },
    ).session(session);

    // Bump tokenVersion for every ACTIVE member (mirrors removeMember): their
    // outstanding access tokens are rejected on the next request, and clearing
    // the refresh token blocks a silent re-issue.
    const memberships = await UserOrganization.find({ organizationId: toOrgId(orgId), isActive: true })
      .select('userId').session(session).lean();
    const userIds = memberships.map((m) => m.userId);
    if (userIds.length > 0) {
      await User.updateMany(
        { _id: { $in: userIds } },
        { $inc: { tokenVersion: 1 }, $unset: { refreshToken: '' } },
      ).session(session);
    }
    return userIds.length;
  });

  logger.info('Org soft-deleted', { orgId, purgeAfter, snapshotId, membersInvalidated });
  return { orgId, deletedAt: now, purgeAfter, snapshotId, membersInvalidated };
}

// ---------------------------------------------------------------------------
// Export (read-only mirror of the cascade)
// ---------------------------------------------------------------------------

/** Single-blob JSON dump of every store's contents for the given org. */
export interface OrgExport {
  exportedAt: string;
  orgId: string;
  postgres: Record<string, unknown[]>;
  mongo: { invitations: unknown[]; auditEvents: unknown[] };
}

/**
 * Walk every store the cascade touches and emit a single JSON blob. Read-
 * only  does not mutate. The returned object is intended for handing to
 * the org as a portability artifact before the delete.
 *
 * `actorOrgId` is needed for the same RLS reason as `cascadeDeleteOrg`
 * the SELECTs must run with a sysadmin context to read rows owned by an
 * org that isn't the caller's own.
 */
export async function exportOrg( orgId: string,
  actorOrgId: string,
): Promise<OrgExport> {
  const result: OrgExport = {
    exportedAt: new Date().toISOString(),
    orgId,
    postgres: {},
    mongo: { invitations: [], auditEvents: [] },
  };

  await runWithTenantContext({ orgId: actorOrgId, isSuperAdmin: true }, async () => {
    for (const { table, name } of [...SOFT_DELETE_TABLES, ...HARD_DELETE_TABLES]) {
      try {
        const rows = await db.select().from(table as never)
          .where(eq((table as { orgId: unknown }).orgId as never, orgId as never));
        result.postgres[name] = rows as unknown[];
      } catch (err) {
        logger.warn('Export read failed', { table: name, orgId, error: errorMessage(err) });
        result.postgres[name] = [];
      }
    }
  });

  try {
    result.mongo.invitations = await Invitation.find({ organizationId: orgId }).lean();
  } catch (err) {
    logger.warn('Invitation export failed', { orgId, error: errorMessage(err) });
  }
  try {
    result.mongo.auditEvents = await AuditEvent.find({
      $or: [{ orgId }, { affectedOrgId: orgId }],
    }).lean();
  } catch (err) {
    logger.warn('AuditEvent export failed', { orgId, error: errorMessage(err) });
  }

  return result;
}

