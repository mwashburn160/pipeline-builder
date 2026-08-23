// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * cascade + export tests.
 *
 * Focus: orchestration correctness  that the right tables are touched, the
 * right HTTP calls fire, and the system-org guard trips. Heavy mocking is
 * intentional; the integration path is exercised by the migration / e2e
 * environment, not by these unit tests.
 */

import { jest, describe, it, expect, beforeEach, test } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({
    delete: mockHttpDelete,
  }),
  getServiceAuthHeader: () => 'Bearer test-service-token',
}));

const mockHttpDelete = jest.fn();

// `runWithTenantContext` is a pass-through in tests  we don't need RLS
// behaviour, just the callback to run. Real RLS plumbing is covered by the
// pipeline-data test suite.
const mockUpdateChain = { set: jest.fn(), where: jest.fn() };
const mockDeleteChain = { where: jest.fn() };
const mockSelectChain = { from: jest.fn(), where: jest.fn() };

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  db: {
    update: jest.fn(() => mockUpdateChain),
    delete: jest.fn(() => mockDeleteChain),
    select: jest.fn(() => mockSelectChain),
  },
  schema: {
    plugin: { orgId: 'plugins.org_id' },
    pipeline: { orgId: 'pipelines.org_id' },
    pipelineTemplate: { orgId: 'pipeline_templates.org_id' },
    message: { orgId: 'messages.org_id' },
    messageAttachment: { orgId: 'message_attachments.org_id' },
    pipelineRegistry: { orgId: 'pipeline_registry.org_id' },
    pipelineEvent: { orgId: 'pipeline_events.org_id' },
    deploymentOutcome: { orgId: 'deployment_outcomes.org_id' },
    incident: { orgId: 'incidents.org_id' },
    ingestHealth: { orgId: 'ingest_health.org_id' },
    doraSettings: { orgId: 'dora_settings.org_id' },
    dashboard: { orgId: 'dashboards.org_id' },
    orgAlertDestination: { orgId: 'org_alert_destinations.org_id' },
    orgAlertRule: { orgId: 'org_alert_rules.org_id' },
    compliancePolicy: { orgId: 'compliance_policies.org_id' },
    complianceRule: { orgId: 'compliance_rules.org_id' },
    complianceRuleHistory: { orgId: 'compliance_rule_history.org_id' },
    complianceAuditLog: { orgId: 'compliance_audit_log.org_id' },
    complianceExemption: { orgId: 'compliance_exemptions.org_id' },
    complianceRuleSubscription: { orgId: 'compliance_rule_subscriptions.org_id' },
    complianceScan: { orgId: 'compliance_scans.org_id' },
    complianceScanSchedule: { orgId: 'compliance_scan_schedules.org_id' },
    complianceNotificationPreference: { orgId: 'compliance_notification_preferences.org_id' },
    complianceNotificationLog: { orgId: 'compliance_notification_log.org_id' },
    complianceRole: { orgId: 'compliance_roles.org_id' },
    complianceReport: { orgId: 'compliance_reports.org_id' },
    complianceReportSchedule: { orgId: 'compliance_report_schedules.org_id' },
  },
  runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
}));

const mockInvitationDeleteMany = jest.fn();
const mockInvitationFind = jest.fn();
const mockAuditDeleteMany = jest.fn();
const mockAuditFind = jest.fn();
const mockAuditCreate = jest.fn();
const mockArchivedBulkWrite = jest.fn();
const mockIdpDeleteMany = jest.fn();
const mockOrgFindById = jest.fn();

jest.unstable_mockModule('../src/models/audit-event.js', () => ({
  __esModule: true,
  default: { deleteMany: mockAuditDeleteMany, find: mockAuditFind, create: mockAuditCreate },
}));
jest.unstable_mockModule('../src/models/archived-audit-events.js', () => ({
  __esModule: true,
  default: { bulkWrite: mockArchivedBulkWrite },
}));
jest.unstable_mockModule('../src/models/invitation.js', () => ({
  __esModule: true,
  default: { deleteMany: mockInvitationDeleteMany, find: mockInvitationFind },
}));
jest.unstable_mockModule('../src/models/organization.js', () => ({
  __esModule: true,
  default: { findById: mockOrgFindById },
}));
jest.unstable_mockModule('../src/models/org-idp-config.js', () => ({
  __esModule: true,
  default: { deleteMany: mockIdpDeleteMany },
}));

const mockOrgDomainDeleteMany = jest.fn();
const mockJoinRequestDeleteMany = jest.fn();
jest.unstable_mockModule('../src/models/org-domain.js', () => ({
  __esModule: true,
  default: { deleteMany: mockOrgDomainDeleteMany },
}));
jest.unstable_mockModule('../src/models/join-request.js', () => ({
  __esModule: true,
  default: { deleteMany: mockJoinRequestDeleteMany },
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    quota: { serviceHost: 'quota', servicePort: 3000 },
    billing: { serviceHost: 'billing', servicePort: 3000 },
  },
}));

const { cascadeDeleteOrg, exportOrg, SYSTEM_ORG_DELETE_FORBIDDEN, CASCADE_TABLE_NAMES } = await import('../src/services/org-cascade-service.js');

// The REAL drizzle schema (deep import — bypasses the barrel's DB pool, which is
// mocked above). Used only by the drift-guard test below to reflect every table.
const { schema: realSchema } = await import('@pipeline-builder/pipeline-data/lib/database/drizzle-schema.js') as { schema: Record<string, unknown> };
const { getTableColumns, getTableName, is } = await import('drizzle-orm');
const { PgTable } = await import('drizzle-orm/pg-core');


beforeEach(() => {
  jest.clearAllMocks();
  // drizzle chain stubs: each call resolves to a 1-row count by default
  mockUpdateChain.set.mockReturnValue(mockUpdateChain);
  mockUpdateChain.where.mockResolvedValue({ rowCount: 1 });
  mockDeleteChain.where.mockResolvedValue({ rowCount: 1 });
  mockSelectChain.from.mockReturnValue(mockSelectChain);
  mockSelectChain.where.mockResolvedValue([]);
  mockHttpDelete.mockResolvedValue({ statusCode: 200, body: {} });
  mockInvitationDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockInvitationFind.mockReturnValue({ lean: () => [] });
  mockAuditDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockAuditFind.mockReturnValue({ lean: () => [] });
  mockAuditCreate.mockResolvedValue({});
  mockArchivedBulkWrite.mockResolvedValue({});
  mockIdpDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockOrgDomainDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockJoinRequestDeleteMany.mockResolvedValue({ deletedCount: 0 });
  // Default: org has no per-org KMS config.
  mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => null }) });
});

/** Build the `Organization.findById(...).select(...).lean()` chain stub for a
 *  given lean() return value. */
function orgLean(value: unknown) {
  return { select: () => ({ lean: () => value }) };
}

describe('cascadeDeleteOrg', () => {
  it('refuses to delete the system org', async () => {
    await expect(cascadeDeleteOrg('000000000000000000000001', '000000000000000000000001')).rejects.toThrow(SYSTEM_ORG_DELETE_FORBIDDEN);
  });

  it('soft-deletes the 9 tables that have a deleted_at column', async () => {
    await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    // 9 soft-delete tables — one update per
    expect(mockUpdateChain.set).toHaveBeenCalledTimes(9);
    expect(mockUpdateChain.where).toHaveBeenCalledTimes(9);
  });

  it('stamps purge_after ALONGSIDE deleted_at on the soft-delete tables so the owning service reclaims them (GDPR)', async () => {
    await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    // Terminal purge must set BOTH `deletedAt` and `purgeAfter` on every
    // soft-delete row — leaving `purgeAfter` NULL would leave the rows
    // (esp. compliance_policies / compliance_rules) lingering forever because
    // the retention sweep is keyed on `deleted_at IS NOT NULL AND purge_after < now`.
    expect(mockUpdateChain.set).toHaveBeenCalledTimes(9);
    for (const call of mockUpdateChain.set.mock.calls) {
      const setArg = call[0] as { deletedAt?: unknown; purgeAfter?: unknown };
      expect(setArg.deletedAt).toBeInstanceOf(Date);
      expect(setArg.purgeAfter).toBeInstanceOf(Date);
      // Same instant for both so the row is immediately eligible for reclamation.
      expect(setArg.purgeAfter).toBe(setArg.deletedAt);
    }
  });

  it('hard-deletes the 18 tables without deleted_at', async () => {
    await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    // 18 hard-delete tables (14 + 4 DORA/reporting: deployment_outcomes,
    // incidents, ingest_health, dora_settings)
    expect(mockDeleteChain.where).toHaveBeenCalledTimes(18);
  });

  it('drops mongo invitations + audit events + idp configs but preserves the admin.org.delete event', async () => {
    mockInvitationDeleteMany.mockResolvedValue({ deletedCount: 3 });
    mockAuditDeleteMany.mockResolvedValue({ deletedCount: 12 });
    mockIdpDeleteMany.mockResolvedValue({ deletedCount: 1 });

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    expect(report.mongo).toEqual({ invitations: 3, auditEvents: 12, idpConfigs: 1, orgDomains: 0, joinRequests: 0 });
    // The deleteMany filter must exclude `admin.org.delete` so the audit
    // trail of the very-just-fired delete event survives.
    const auditCallArg = mockAuditDeleteMany.mock.calls[0][0];
    expect(auditCallArg.action).toEqual({ $ne: 'admin.org.delete' });
    expect(auditCallArg.$or).toEqual([{ orgId: 'org-acme' }, { affectedOrgId: 'org-acme' }]);

    // IdP cleanup scoped to the deleted org's id — orphaned configs were
    // the bug this guards against.
    expect(mockIdpDeleteMany).toHaveBeenCalledWith({ orgId: 'org-acme' });
  });

  it('ARCHIVES the audit trail to archived_audit_events BEFORE deleting the live rows', async () => {
    const events = [
      { _id: 'evt-1', action: 'user.login', orgId: 'org-acme' },
      { _id: 'evt-2', action: 'admin.user.update', affectedOrgId: 'org-acme' },
    ];
    mockAuditFind.mockReturnValue({ lean: () => events });
    mockAuditDeleteMany.mockResolvedValue({ deletedCount: 2 });

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    // Every matching event is upserted into the archive by ORIGINAL _id (so a
    // purge retry is idempotent) with an archivedAt stamp.
    expect(mockArchivedBulkWrite).toHaveBeenCalledTimes(1);
    const ops = mockArchivedBulkWrite.mock.calls[0][0] as Array<{ replaceOne: { filter: unknown; replacement: any; upsert: boolean } }>;
    expect(ops.map((o) => o.replaceOne.filter)).toEqual([{ _id: 'evt-1' }, { _id: 'evt-2' }]);
    expect(ops[0].replaceOne.upsert).toBe(true);
    expect(ops[0].replaceOne.replacement).toMatchObject({ _id: 'evt-1', action: 'user.login' });
    expect(ops[0].replaceOne.replacement.archivedAt).toBeInstanceOf(Date);

    // Archive succeeded → live rows deleted → report flags the archive ok.
    expect(report.auditArchive).toEqual({ ok: true, archived: 2 });
    expect(report.mongo.auditEvents).toBe(2);
  });

  it('FAIL-CLOSED: does NOT delete audit rows when the archive write fails', async () => {
    mockAuditFind.mockReturnValue({ lean: () => [{ _id: 'evt-1', action: 'user.login', orgId: 'org-acme' }] });
    mockArchivedBulkWrite.mockRejectedValue(new Error('archive store down'));

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    // The live audit rows were left intact (delete never ran) and the report
    // flags the failure so the purge sweep defers the hard delete.
    expect(mockAuditDeleteMany).not.toHaveBeenCalled();
    expect(report.auditArchive.ok).toBe(false);
    expect(report.auditArchive.error).toMatch(/archive store down/);
  });

  it('skips the archive write when there are no audit events, still flags ok', async () => {
    // Default beforeEach: mockAuditFind returns [].
    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    expect(mockArchivedBulkWrite).not.toHaveBeenCalled();
    expect(report.auditArchive).toEqual({ ok: true, archived: 0 });
  });

  it('reports zero idpConfigs cleanly when none exist', async () => {
    mockInvitationDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockAuditDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockIdpDeleteMany.mockResolvedValue({ deletedCount: 0 });

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    expect(report.mongo.idpConfigs).toBe(0);
  });

  it('fires DELETE at the quota and billing services with a service token', async () => {
    await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    const paths = mockHttpDelete.mock.calls.map((c: unknown[]) => c[0]);
    expect(paths).toContain('/quotas/org-acme');
    expect(paths).toContain('/billing/subscriptions/by-org/org-acme');

    for (const call of mockHttpDelete.mock.calls) {
      const opts = call[1] as { headers: Record<string, string> };
      expect(opts.headers.Authorization).toBe('Bearer test-service-token');
      expect(opts.headers['x-org-id']).toBe('org-acme');
    }
  });

  it('reports quota/billing as ok when the downstream returns 2xx', async () => {
    mockHttpDelete.mockResolvedValue({ statusCode: 200, body: {} });
    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    expect(report.quota).toEqual({ ok: true, statusCode: 200 });
    expect(report.billing).toEqual({ ok: true, statusCode: 200 });
  });

  it('reports ok=false when the downstream returns 5xx  but does not throw (best-effort)', async () => {
    mockHttpDelete.mockResolvedValue({ statusCode: 503, body: {} });
    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    expect(report.quota.ok).toBe(false);
    expect(report.billing.ok).toBe(false);
  });

  it('fires the message-service attachment-blob purge with a service token', async () => {
    await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    const paths = mockHttpDelete.mock.calls.map((c: unknown[]) => c[0]);
    expect(paths).toContain('/messages/internal/org/org-acme/attachments');
  });

  it('reports messageBlobs ok + deleted count from the purge response', async () => {
    mockHttpDelete.mockResolvedValue({ statusCode: 200, body: { data: { deleted: 7 } } });
    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    expect(report.messageBlobs).toEqual({ ok: true, statusCode: 200, deleted: 7 });
  });

  it('reports messageBlobs ok=false on a non-2xx purge (orphans flagged, not fatal)', async () => {
    mockHttpDelete.mockResolvedValue({ statusCode: 500, body: {} });
    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    expect(report.messageBlobs.ok).toBe(false);
    expect(report.messageBlobs.statusCode).toBe(500);
  });

  it('continues past a Postgres delete failure on one table without aborting the rest', async () => {
    // First update fails, the rest succeed.
    mockUpdateChain.where
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({ rowCount: 1 });

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    // The first table reports { ok: false, error } (the new structured
    // failure marker, replacing the old -1 sentinel); others report ok=true.
    const entries = Object.values(report.postgres);
    expect(entries.some((e) => e.ok === false)).toBe(true);
    expect(entries.filter((e) => e.ok === true).length).toBe(entries.length - 1);
    // Other tables still got their delete chains called.
    expect(mockUpdateChain.where).toHaveBeenCalledTimes(9);
    expect(mockDeleteChain.where).toHaveBeenCalledTimes(18);
  });

  it('flags an orphaned per-org KMS key (audit event + report) but does NOT auto-delete it', async () => {
    mockOrgFindById.mockReturnValue(orgLean({ kmsConfig: { keyId: 'arn:aws:kms:us-east-1:key/abc', ciphertextBase64: 'd3JhcHBlZA==' } }));

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    // Report carries the operator-actionable flag + key identifier.
    expect(report.kms).toEqual({ flagged: true, keyRef: 'arn:aws:kms:us-east-1:key/abc' });

    // An audit event was emitted so an operator can follow up manually.
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    const auditArg = mockAuditCreate.mock.calls[0][0] as {
      action: string; affectedOrgId: string; targetId: string; details: { keyId?: string };
    };
    expect(auditArg.action).toBe('org.kms.orphaned');
    expect(auditArg.affectedOrgId).toBe('org-acme');
    expect(auditArg.targetId).toBe('org-acme');
    expect(auditArg.details.keyId).toBe('arn:aws:kms:us-east-1:key/abc');
  });

  it('does NOT flag KMS when the org has no per-org key', async () => {
    // Default beforeEach org has no kmsConfig.
    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    expect(report.kms).toBeUndefined();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

describe('exportOrg', () => {
  it('reads from every cascade-targeted table + mongo collection', async () => {
    mockSelectChain.where.mockResolvedValue([{ id: 'a' }]);
    mockInvitationFind.mockReturnValue({ lean: () => [{ email: 'foo@example.com' }] });
    mockAuditFind.mockReturnValue({ lean: () => [{ action: 'user.login' }] });

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    expect(Object.keys(dump.postgres).length).toBe(27); // 9 soft + 18 hard
    expect(dump.mongo.invitations).toHaveLength(1);
    expect(dump.mongo.auditEvents).toHaveLength(1);
    expect(dump.orgId).toBe('org-acme');
    expect(dump.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('org cascade drift guard (schema reflection)', () => {
  it('cascades EVERY org-scoped Postgres table', () => {
    // Reflect the real drizzle schema: any table with an `org_id` column MUST be
    // in the cascade (soft or hard) or it orphans on org purge + is missing from
    // the GDPR export. A failure here means: add the new table to SOFT/HARD_DELETE_TABLES.
    const uncovered: string[] = [];
    for (const val of Object.values(realSchema)) {
      if (!is(val, PgTable)) continue;
      const cols = getTableColumns(val as never);
      const hasOrgId = Object.values(cols).some((c) => (c as { name: string }).name === 'org_id');
      if (!hasOrgId) continue;
      const name = getTableName(val as never);
      if (!CASCADE_TABLE_NAMES.has(name)) uncovered.push(name);
    }
    expect(uncovered).toEqual([]);
  });

  it('covers the two tables that were previously omitted', () => {
    expect(CASCADE_TABLE_NAMES.has('org_alert_rules')).toBe(true);
    expect(CASCADE_TABLE_NAMES.has('pipeline_templates')).toBe(true);
  });
});
