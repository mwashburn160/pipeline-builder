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

// Every statement must run inside withTenantTx (which applies the RLS context);
// the transaction handle is the only way to reach the query builders here.
const mockTx = {
  update: jest.fn(() => mockUpdateChain),
  delete: jest.fn(() => mockDeleteChain),
  select: jest.fn(() => mockSelectChain),
};
const mockWithTenantTx = jest.fn(async (fn: (tx: typeof mockTx) => unknown) => fn(mockTx));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  withTenantTx: (fn: (tx: typeof mockTx) => unknown) => mockWithTenantTx(fn),
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
  // Shared row-level soft-delete window (SOFT_DELETE_RETENTION_DAYS, 30d) — the
  // FLOOR under the org's own purge deadline.
  softDeleteRetentionMs: () => 30 * 24 * 60 * 60 * 1000,
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
  default: { deleteMany: mockIdpDeleteMany, find: mongoFinds.orgIdpConfig },
}));
// IdP group → Role mappings (3a) — cleaned up with the IdP config they belong to.
const mockIdpGroupMappingDeleteMany = jest.fn();
jest.unstable_mockModule('../src/models/idp-group-mapping.js', () => ({
  __esModule: true,
  default: { deleteMany: mockIdpGroupMappingDeleteMany, find: mongoFinds.idpGroupMapping },
}));

const mockOrgDomainDeleteMany = jest.fn();
const mockJoinRequestDeleteMany = jest.fn();
const mockServiceAccountFind = jest.fn();
const mockServiceAccountDeleteMany = jest.fn();
const mockSaKeyDeleteMany = jest.fn();
const mockRoleAssignmentDeleteMany = jest.fn();
const mockSamlSessionDeleteMany = jest.fn();

/**
 * Mongoose query stub covering every chain the cascade + export use
 * (`.select().lean()`, `.sort().limit().lean()`, plain `.lean()`).
 */
const findChain = (rows: unknown[] = []) => {
  const c: any = { lean: async () => rows, select: () => c, sort: () => c, limit: () => c };
  return c;
};

/**
 * Every collection the export reads, so a new cascade target shows up as a
 * missing mock here rather than a silently empty artifact. Each entry is the
 * model's `find` spy; the reflection test below asserts the export names them.
 */
const mongoFinds = {
  orgIdpConfig: jest.fn(() => findChain()),
  idpGroupMapping: jest.fn(() => findChain()),
  orgDomain: jest.fn(() => findChain()),
  joinRequest: jest.fn(() => findChain()),
  samlSession: jest.fn(() => findChain()),
  personalAccessToken: jest.fn(() => findChain()),
  userOrganization: jest.fn(() => findChain()),
  roleAssignment: jest.fn(() => findChain()),
  role: jest.fn(() => findChain()),
};

jest.unstable_mockModule('../src/models/org-domain.js', () => ({
  __esModule: true,
  default: { deleteMany: mockOrgDomainDeleteMany, find: mongoFinds.orgDomain },
}));
jest.unstable_mockModule('../src/models/join-request.js', () => ({
  __esModule: true,
  default: { deleteMany: mockJoinRequestDeleteMany, find: mongoFinds.joinRequest },
}));
// SAML SLO bookkeeping — org-scoped, so it goes with the org.
jest.unstable_mockModule('../src/models/saml-session.js', () => ({
  __esModule: true,
  default: { deleteMany: mockSamlSessionDeleteMany, find: mongoFinds.samlSession },
}));
// Service accounts (#2): org property, so the purge deletes them along with
// every key and Role assignment they hold.
jest.unstable_mockModule('../src/models/service-account.js', () => ({
  __esModule: true,
  default: { find: mockServiceAccountFind, deleteMany: mockServiceAccountDeleteMany },
}));
jest.unstable_mockModule('../src/models/personal-access-token.js', () => ({
  __esModule: true,
  default: { deleteMany: mockSaKeyDeleteMany, updateMany: jest.fn(), find: mongoFinds.personalAccessToken },
}));
jest.unstable_mockModule('../src/models/role-assignment.js', () => ({
  __esModule: true,
  default: { deleteMany: mockRoleAssignmentDeleteMany, find: mongoFinds.roleAssignment },
}));
jest.unstable_mockModule('../src/models/role.js', () => ({
  __esModule: true,
  default: { find: mongoFinds.role },
}));
jest.unstable_mockModule('../src/models/user-organization.js', () => ({
  __esModule: true,
  default: { find: mongoFinds.userOrganization },
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    quota: { serviceHost: 'quota', servicePort: 3000 },
    billing: { serviceHost: 'billing', servicePort: 3000 },
    message: { serviceHost: 'message', servicePort: 3000 },
    organization: { cascadeHttpTimeoutMs: 5000 },
  },
}));

const { cascadeDeleteOrg, exportOrg, CASCADE_TABLE_NAMES, CASCADE_MONGO_COLLECTION_NAMES } = await import('../src/services/org-cascade-service.js');
const { SYSTEM_ORG_DELETE_FORBIDDEN } = await import('../src/services/org-errors.js');

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
  mockAuditFind.mockReturnValue(auditCursor([]));
  mockAuditCreate.mockResolvedValue({});
  mockArchivedBulkWrite.mockResolvedValue({});
  mockIdpDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockIdpGroupMappingDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockOrgDomainDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockJoinRequestDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockSamlSessionDeleteMany.mockResolvedValue({ deletedCount: 0 });
  for (const find of Object.values(mongoFinds)) find.mockImplementation(() => findChain());
  // One service account with two keys, so the purge's teardown leg is exercised.
  mockServiceAccountFind.mockReturnValue(findChain([{ _id: 'sa-1' }]));
  mockServiceAccountDeleteMany.mockResolvedValue({ deletedCount: 1 });
  mockSaKeyDeleteMany.mockResolvedValue({ deletedCount: 2 });
  mockRoleAssignmentDeleteMany.mockResolvedValue({ deletedCount: 1 });
  // Default: org has no per-org KMS config.
  mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => null }) });
});

/**
 * Stub for the audit-archive read: `AuditEvent.find(...).lean().cursor()`.
 *
 * The purge STREAMS the trail in fixed batches rather than materializing it —
 * a tenant at the retention ceiling OOM-killed the pod, and since the archive
 * is fail-closed the next sweep retried the same org forever. So the stub has
 * to expose a cursor, not a resolved array.
 */
function auditCursor(rows: unknown[]) {
  return {
    lean: () => ({
      cursor: () => ({
        [Symbol.asyncIterator]: async function* asyncIterator() { yield* rows; },
        close: async () => {},
      }),
    }),
  };
}

/**
 * Stub for the export read: `AuditEvent.find(...).sort().limit().lean()`.
 *
 * The export materializes into one JSON object, so it takes a hard CAP and
 * reports truncation rather than streaming (unlike the archive above).
 * `capture` records the applied limit so a test can assert the cap.
 */
function auditCapped(rows: unknown[], capture?: (limit: number) => void) {
  const q = {
    sort: () => q,
    limit: (n: number) => { capture?.(n); return q; },
    lean: async () => rows,
  };
  return q;
}

/** Build the `Organization.findById(...).select(...).lean()` chain stub for a
 *  given lean() return value. */
function orgLean(value: unknown) {
  return { select: () => ({ lean: () => value }) };
}

describe('cascadeDeleteOrg', () => {
  it('refuses to delete the system org', async () => {
    await expect(cascadeDeleteOrg('000000000000000000000001', '000000000000000000000001')).rejects.toThrow(SYSTEM_ORG_DELETE_FORBIDDEN);
  });

  it('runs every Postgres statement inside withTenantTx — a bare db call has no RLS context', async () => {
    await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    // One tenant transaction per soft-delete (9) and hard-delete table.
    expect(mockWithTenantTx.mock.calls.length).toBe(mockTx.update.mock.calls.length + mockTx.delete.mock.calls.length);
    expect(mockTx.update).toHaveBeenCalledTimes(9);
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

  it('drops mongo invitations + audit events + idp configs + saml sessions', async () => {
    mockInvitationDeleteMany.mockResolvedValue({ deletedCount: 3 });
    mockAuditDeleteMany.mockResolvedValue({ deletedCount: 12 });
    mockIdpDeleteMany.mockResolvedValue({ deletedCount: 1 });
    mockSamlSessionDeleteMany.mockResolvedValue({ deletedCount: 4 });

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    expect(report.mongo).toEqual({
      invitations: 3,
      auditEvents: 12,
      idpConfigs: 1,
      idpGroupMappings: 0,
      orgDomains: 0,
      joinRequests: 0,
      // SAML SLO rows are org-scoped and went with the org.
      samlSessions: 4,
      // Service accounts are org property — the purge takes them and their keys.
      serviceAccounts: 1,
      serviceAccountKeys: 2,
    });
    expect(mockSamlSessionDeleteMany).toHaveBeenCalledWith({ orgId: 'org-acme' });
    // The live delete is exactly this org's own hash chain (chain key =
    // affectedOrgId). An event this org's members performed on ANOTHER org
    // (orgId = org-acme, affectedOrgId = other) is a link in THAT org's chain;
    // deleting it would break the other tenant's tamper-evidence.
    expect(mockAuditDeleteMany).toHaveBeenCalledWith({ affectedOrgId: 'org-acme' });
    // The archive still copies both sides.
    expect(mockAuditFind).toHaveBeenCalledWith({ $or: [{ orgId: 'org-acme' }, { affectedOrgId: 'org-acme' }] });

    // IdP cleanup scoped to the deleted org's id — orphaned configs were
    // the bug this guards against.
    expect(mockIdpDeleteMany).toHaveBeenCalledWith({ orgId: 'org-acme' });
  });

  it('ARCHIVES the audit trail to archived_audit_events BEFORE deleting the live rows', async () => {
    const events = [
      { _id: 'evt-1', action: 'user.login', orgId: 'org-acme' },
      { _id: 'evt-2', action: 'admin.user.update', affectedOrgId: 'org-acme' },
    ];
    mockAuditFind.mockReturnValue(auditCursor(events));
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
    mockAuditFind.mockReturnValue(auditCursor([{ _id: 'evt-1', action: 'user.login', orgId: 'org-acme' }]));
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

  it('deletes the org SERVICE ACCOUNTS with their keys and role assignments', async () => {
    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    expect(report.mongo.serviceAccounts).toBe(1);
    expect(report.mongo.serviceAccountKeys).toBe(2);
    // Keys first, then assignments, then the accounts: an interrupted purge can
    // only ever leave FEWER credentials, never a live key with no account.
    expect(mockSaKeyDeleteMany).toHaveBeenCalledWith({ serviceAccountId: { $in: ['sa-1'] } });
    expect(mockRoleAssignmentDeleteMany).toHaveBeenCalledWith({ serviceAccountId: { $in: ['sa-1'] } });
    expect(mockServiceAccountDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['sa-1'] } });
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
    mockAuditFind.mockReturnValue(auditCapped([{ action: 'user.login' }]));

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    expect(Object.keys(dump.postgres).length).toBe(27); // 9 soft + 18 hard
    expect(dump.mongo.invitations).toHaveLength(1);
    expect(dump.mongo.auditEvents).toHaveLength(1);
    expect(dump.orgId).toBe('org-acme');
    expect(dump.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /**
   * The Mongo twin of the CASCADE_TABLE_NAMES drift guard. The export used to
   * carry ONLY invitations + audit events while the teardown removed the IdP
   * config, group mappings, domains, join requests, SAML sessions, service
   * accounts + keys, memberships, Role assignments and Roles — so the
   * soft-delete "recovery snapshot" could not actually restore an org, and the
   * portability artifact under-reported what the platform held.
   */
  it('DRIFT GUARD: every collection the teardown removes appears in the artifact', async () => {
    const dump = await exportOrg('org-acme', '000000000000000000000001');

    const missing = [...CASCADE_MONGO_COLLECTION_NAMES].filter((name) => !(name in dump.mongo));
    expect(missing).toEqual([]);
    // And the set actually names the collections that were previously omitted.
    for (const name of [
      'idpConfigs', 'idpGroupMappings', 'orgDomains', 'joinRequests', 'samlSessions',
      'serviceAccounts', 'serviceAccountKeys', 'memberships', 'roleAssignments', 'roles',
    ]) {
      expect(CASCADE_MONGO_COLLECTION_NAMES.has(name)).toBe(true);
    }
  });

  it('captures the rows of each newly covered collection', async () => {
    mongoFinds.orgIdpConfig.mockReturnValue(findChain([{ entityId: 'idp' }]));
    mongoFinds.orgDomain.mockReturnValue(findChain([{ domain: 'acme.test' }]));
    mongoFinds.userOrganization.mockReturnValue(findChain([{ userId: 'u1' }, { userId: 'u2' }]));
    mongoFinds.role.mockReturnValue(findChain([{ name: 'Admin' }]));
    mockServiceAccountFind.mockReturnValue(findChain([{ _id: 'sa-1' }]));
    mongoFinds.personalAccessToken.mockReturnValue(findChain([{ _id: 'k1', prefix: 'pb_sa' }]));

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    expect(dump.mongo.idpConfigs).toHaveLength(1);
    expect(dump.mongo.orgDomains).toHaveLength(1);
    expect(dump.mongo.memberships).toHaveLength(2);
    expect(dump.mongo.roles).toHaveLength(1);
    expect(dump.mongo.serviceAccounts).toHaveLength(1);
    expect(dump.mongo.serviceAccountKeys).toHaveLength(1);
  });

  it('never exports a service-account key HASH (the stored form of the secret)', async () => {
    const select = jest.fn(() => findChain([{ _id: 'k1' }]));
    mockServiceAccountFind.mockReturnValue(findChain([{ _id: 'sa-1' }]));
    mongoFinds.personalAccessToken.mockReturnValue({ select } as never);

    await exportOrg('org-acme', '000000000000000000000001');

    expect(select).toHaveBeenCalledWith('-keyHash');
  });

  it('caps the audit read so one tenant cannot exhaust the heap', async () => {
    mockSelectChain.where.mockResolvedValue([]);
    mockInvitationFind.mockReturnValue({ lean: () => [] });
    let applied = 0;
    mockAuditFind.mockReturnValue(auditCapped([{ action: 'user.login' }], (n) => { applied = n; }));

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    expect(applied).toBeGreaterThan(0);
    // Under the cap → a complete artifact, no truncation marker.
    expect(dump.truncated).toBeUndefined();
  });

  it('REPORTS truncation when the audit read fills the cap (never silently partial)', async () => {
    mockSelectChain.where.mockResolvedValue([]);
    mockInvitationFind.mockReturnValue({ lean: () => [] });
    let cap = 0;
    // Return exactly `cap` rows, which is how the service detects truncation.
    mockAuditFind.mockImplementation(() => {
      const q = {
        sort: () => q,
        limit: (n: number) => { cap = n; return q; },
        lean: async () => Array.from({ length: cap }, (_, i) => ({ action: 'user.login', _id: String(i) })),
      };
      return q;
    });

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    expect(dump.truncated).toEqual({ auditEvents: { cap } });
    expect(dump.mongo.auditEvents).toHaveLength(cap);
  });
});

describe('exportOrg — read failures', () => {
  const emptyReads = () => {
    mockInvitationFind.mockReturnValue({ lean: () => [] });
    mockAuditFind.mockReturnValue(auditCapped([]));
  };

  it('lenient (portability export): names every store it could not read instead of passing it off as empty', async () => {
    emptyReads();
    mockSelectChain.where.mockRejectedValueOnce(new Error('relation down'));
    mockInvitationFind.mockReturnValue({ lean: () => Promise.reject(new Error('mongo blip')) });

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    expect(dump.failed).toEqual({ postgres: ['plugins'], mongo: ['invitations'] });
    expect(dump.postgres.plugins).toEqual([]);
  });

  it('lenient: no `failed` marker when every store was read', async () => {
    emptyReads();
    const dump = await exportOrg('org-acme', '000000000000000000000001');
    expect(dump.failed).toBeUndefined();
  });

  it('strict: rethrows a Postgres table failure', async () => {
    emptyReads();
    mockSelectChain.where.mockRejectedValueOnce(new Error('relation down'));
    await expect(exportOrg('org-acme', '000000000000000000000001', { strict: true })).rejects.toThrow('relation down');
  });

  it('strict: rethrows a Mongo collection failure', async () => {
    emptyReads();
    mockAuditFind.mockImplementation(() => { throw new Error('audit read failed'); });
    await expect(exportOrg('org-acme', '000000000000000000000001', { strict: true })).rejects.toThrow('audit read failed');
  });
});

describe('cascadeDeleteOrg — audit archive is batched', () => {
  it('archives in fixed batches instead of one bulkWrite over the whole trail', async () => {
    // A retention-ceiling tenant OOM-killed the pod here, and because the
    // archive is fail-closed the next sweep retried the same org and died the
    // same way — a permanent purge (and GDPR-erasure) stall.
    const events = Array.from({ length: 2500 }, (_, i) => ({ _id: `e${i}`, action: 'user.login', orgId: 'org-acme' }));
    mockAuditFind.mockReturnValue(auditCursor(events));
    mockAuditDeleteMany.mockResolvedValue({ deletedCount: events.length });

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    expect(report.auditArchive).toEqual({ ok: true, archived: 2500 });
    // 2500 events → 3 batches (1000 + 1000 + 500), not a single 2500-op write.
    expect(mockArchivedBulkWrite).toHaveBeenCalledTimes(3);
    for (const call of mockArchivedBulkWrite.mock.calls) {
      expect((call[0] as unknown[]).length).toBeLessThanOrEqual(1000);
    }
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
