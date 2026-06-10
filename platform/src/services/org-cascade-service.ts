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
import { db, runWithTenantContext, schema } from '@pipeline-builder/pipeline-core';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config/index.js';
import AuditEvent from '../models/audit-event.js';
import Invitation from '../models/invitation.js';
import OrgIdpConfig from '../models/org-idp-config.js';

const logger = createLogger('org-cascade');

/** Cannot delete the system org. Matches the existing org-delete guard.
 *  Same string value as `services/organization-service`'s export — the
 *  controller errorMap uses that one. Kept exported because the cascade
 *  test imports this constant. */
export const SYSTEM_ORG_DELETE_FORBIDDEN = 'SYSTEM_ORG_DELETE_FORBIDDEN';

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

  logger.info('Org cascade complete', { orgId, report });
  return report;
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

