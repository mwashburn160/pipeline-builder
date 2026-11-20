// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * cascade + export tests.
 *
 * Focus: orchestration correctness — that platform tears down only its OWN
 * stores (no direct call to any downstream service: those are cascade-outbox
 * legs), the export still walks every org-scoped table, and the system-org
 * guard trips. Heavy mocking is
 * intentional; the integration path is exercised by the e2e environment, not
 * by these unit tests.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { queryChain } from './helpers/query-chain.js';
// Any HTTP client the cascade builds is a regression: downstream services are
// reached ONLY through the cascade outbox now (see cascade-outbox.test.ts).
const mockCreateSafeClient = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: (...a: unknown[]) => mockCreateSafeClient(...a),
}));

// The REAL ownership map (deep import — it loads nothing but the schema), so the
// drift guard and the export walk reflect what production purges.
const ownership = await import('@pipeline-builder/pipeline-data/lib/api/org-data-ownership.js') as typeof import('@pipeline-builder/pipeline-data');

// Platform's own Postgres slice goes through pipeline-data's executor; its SQL
// is pinned against a real Postgres in pipeline-data's org-data-purge.test.ts.
const mockPurgeOrgData = jest.fn<AnyFn>();
// The export's reads still run inside withTenantTx (which applies the RLS context).
const mockSelectChain = { from: jest.fn<AnyFn>(), where: jest.fn<AnyFn>() };
const mockTx = { select: jest.fn((..._args: unknown[]) => mockSelectChain) };
const mockWithTenantTx = jest.fn(async (fn: (tx: typeof mockTx) => unknown) => fn(mockTx));

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  withTenantTx: (fn: (tx: typeof mockTx) => unknown) => mockWithTenantTx(fn),
  purgeOrgData: (...a: unknown[]) => mockPurgeOrgData(...a),
  ORG_DATA_OWNERSHIP: ownership.ORG_DATA_OWNERSHIP,
  ORG_SCOPED_TABLE_NAMES: ownership.ORG_SCOPED_TABLE_NAMES,
  allOrgScopedTables: ownership.allOrgScopedTables,
  redactSecretColumns: ownership.redactSecretColumns,
  runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  // Shared row-level soft-delete window (SOFT_DELETE_RETENTION_DAYS, 30d) — the
  // FLOOR under the org's own purge deadline.
  softDeleteRetentionMs: () => 30 * 24 * 60 * 60 * 1000,
}));

/** `purgeOrgData`'s result for platform's slice, every table ok with `rows` rows. */
function platformPurge(rows = 1, failed: string[] = []) {
  const tables: Record<string, { ok: boolean; rowCount?: number; error?: string }> = {};
  const slice = ownership.ORG_DATA_OWNERSHIP.platform;
  for (const { name } of [...slice.soft, ...slice.hard]) {
    tables[name] = failed.includes(name) ? { ok: false, error: 'boom' } : { ok: true, rowCount: rows };
  }
  return { orgId: 'org-acme', owner: 'platform', tables, failed };
}

const mockInvitationDeleteMany = jest.fn<AnyFn>();
const mockInvitationFind = jest.fn<AnyFn>();
const mockAuditDeleteMany = jest.fn<AnyFn>();
const mockAuditFind = jest.fn<AnyFn>();
const mockAuditCreate = jest.fn<AnyFn>();
const mockArchivedBulkWrite = jest.fn<AnyFn>();
const mockIdpDeleteMany = jest.fn<AnyFn>();
const mockOrgFindById = jest.fn<AnyFn>();

jest.unstable_mockModule('../src/models/audit-event.js', () => ({
  __esModule: true,
  default: { deleteMany: mockAuditDeleteMany, find: mockAuditFind, create: mockAuditCreate },
}));
// The chain head the audit append reads/advances (no live Mongo here).
jest.unstable_mockModule('../src/models/audit-chain-head.js', () => ({
  __esModule: true,
  default: {
    findById: () => ({ select: () => ({ lean: async () => null }) }),
    updateOne: async () => ({}),
  },
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
// IdP group → Role mappings — cleaned up with the IdP config they belong to.
const mockIdpGroupMappingDeleteMany = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/idp-group-mapping.js', () => ({
  __esModule: true,
  default: { deleteMany: mockIdpGroupMappingDeleteMany, find: mongoFinds.idpGroupMapping },
}));

const mockOrgDomainDeleteMany = jest.fn<AnyFn>();
const mockJoinRequestDeleteMany = jest.fn<AnyFn>();
const mockServiceAccountFind = jest.fn<AnyFn>();
const mockServiceAccountDeleteMany = jest.fn<AnyFn>();
const mockSaKeyDeleteMany = jest.fn<AnyFn>();
/** Members' personal (`pb_pat`) keys scoped to the org — same model as SA keys,
 *  told apart by the filter (`userId` vs `serviceAccountId`). */
const mockPersonalPatDeleteMany = jest.fn<AnyFn>();
const mockMfaResetDeleteMany = jest.fn<AnyFn>();
const mockImpersonationDeleteMany = jest.fn<AnyFn>();
const mockRoleAssignmentDeleteMany = jest.fn<AnyFn>();
const mockSamlSessionDeleteMany = jest.fn<AnyFn>();

/**
 * Mongoose query stub covering every chain the cascade + export use
 * (`.select().lean()`, `.sort().limit().lean()`, plain `.lean()`).
 */
const findChain = (rows: unknown[] = []) => queryChain(rows);

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
  mfaResetRequest: jest.fn(() => findChain()),
  impersonationRequest: jest.fn(() => findChain()),
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
// Service accounts: org property, so the purge deletes them along with
// every key and Role assignment they hold.
jest.unstable_mockModule('../src/models/service-account.js', () => ({
  __esModule: true,
  default: { find: mockServiceAccountFind, deleteMany: mockServiceAccountDeleteMany },
}));
jest.unstable_mockModule('../src/models/personal-access-token.js', () => ({
  __esModule: true,
  default: {
    deleteMany: (filter: Record<string, unknown>) => ('userId' in filter ? mockPersonalPatDeleteMany(filter) : mockSaKeyDeleteMany(filter)),
    updateMany: jest.fn<AnyFn>(),
    find: mongoFinds.personalAccessToken,
  },
}));
jest.unstable_mockModule('../src/models/mfa-reset-request.js', () => ({
  __esModule: true,
  default: { deleteMany: mockMfaResetDeleteMany, find: mongoFinds.mfaResetRequest },
}));
jest.unstable_mockModule('../src/models/impersonation-request.js', () => ({
  __esModule: true,
  default: { deleteMany: mockImpersonationDeleteMany, find: mongoFinds.impersonationRequest },
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

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  audit: { retentionDays: 90 },
}));

const { cascadeDeleteOrg, exportOrg, archivedAuditExpiry } = await import('../src/services/org-cascade-service.js');
const { CASCADE_TABLE_NAMES, CASCADE_MONGO_COLLECTION_NAMES, EXPORT_TABLES, SOFT_DELETE_TABLES, HARD_DELETE_TABLES } = await import('../src/services/org-cascade-registry.js');
const { SYSTEM_ORG_DELETE_FORBIDDEN } = await import('../src/services/org-errors.js');

// The REAL drizzle schema (deep import — bypasses the barrel's DB pool, which is
// mocked above). Used only by the drift-guard test below to reflect every table.
const { schema: realSchema } = await import('@pipeline-builder/pipeline-data/lib/database/drizzle-schema.js') as { schema: Record<string, unknown> };
const { getTableColumns, getTableName, is } = await import('drizzle-orm');
const { PgTable } = await import('drizzle-orm/pg-core');


beforeEach(() => {
  jest.clearAllMocks();
  mockPurgeOrgData.mockResolvedValue(platformPurge());
  mockSelectChain.from.mockReturnValue(mockSelectChain);
  mockSelectChain.where.mockResolvedValue([]);
  mockInvitationDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockInvitationFind.mockReturnValue(findChain([]));
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
  mockPersonalPatDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockMfaResetDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mockImpersonationDeleteMany.mockResolvedValue({ deletedCount: 0 });
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

  it('tears down ONLY platform\'s own Postgres slice, through the shared executor', async () => {
    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    expect(mockPurgeOrgData).toHaveBeenCalledTimes(1);
    expect(mockPurgeOrgData).toHaveBeenCalledWith('platform', 'org-acme');
    // Its per-table outcome is the report's postgres section.
    expect(Object.keys(report.postgres).sort()).toEqual([...SOFT_DELETE_TABLES, ...HARD_DELETE_TABLES].map((t) => t.name).sort());
  });

  it('owns only platform tables — every other org-scoped table is a downstream service\'s outbox leg', () => {
    const own = [...SOFT_DELETE_TABLES, ...HARD_DELETE_TABLES].map((t) => t.name).sort();
    expect(own).toEqual(['support_contacts']);
    // e.g. pipelines, compliance_rules, messages, report_runs are NOT platform's to write.
    // The ops tables (dashboards, alert rules/destinations) are ops-center's leg now.
    for (const foreign of ['pipelines', 'plugins', 'compliance_rules', 'messages', 'report_runs', 'support_cases', 'incidents', 'dashboards', 'org_alert_rules', 'org_alert_destinations']) {
      expect(own).not.toContain(foreign);
    }
  });

  it('makes NO direct call to any downstream service (they are reached through the outbox)', async () => {
    await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    expect(mockCreateSafeClient).not.toHaveBeenCalled();
  });

  it('reports a failed platform table as { ok: false } (the purge defers on it)', async () => {
    mockPurgeOrgData.mockResolvedValue(platformPurge(1, ['support_contacts']));
    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');
    expect(report.postgres.support_contacts).toEqual({ ok: false, error: 'boom' });
  });

  it("deletes members' org-scoped personal keys, MFA-reset and impersonation requests", async () => {
    mockPersonalPatDeleteMany.mockResolvedValue({ deletedCount: 3 });
    mockMfaResetDeleteMany.mockResolvedValue({ deletedCount: 1 });
    mockImpersonationDeleteMany.mockResolvedValue({ deletedCount: 2 });

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    // Personal keys only (userId set) — never another org's, never SA keys.
    expect(mockPersonalPatDeleteMany).toHaveBeenCalledWith({ userId: { $ne: null }, organizationId: 'org-acme' });
    expect(mockMfaResetDeleteMany).toHaveBeenCalledWith({ organizationId: 'org-acme' });
    expect(mockImpersonationDeleteMany).toHaveBeenCalledWith({ organizationId: 'org-acme' });
    expect(report.mongo).toMatchObject({ personalAccessTokens: 3, mfaResetRequests: 1, impersonationRequests: 2 });
  });

  it('reports every failed Mongo leg in mongoFailures (the purge defers on it)', async () => {
    mockSamlSessionDeleteMany.mockRejectedValue(new Error('mongo blip'));
    mockServiceAccountFind.mockImplementation(() => { throw new Error('sa blip'); });

    const report = await cascadeDeleteOrg('org-acme', '000000000000000000000001');

    expect(report.mongoFailures).toEqual(expect.arrayContaining(['samlSessions', 'serviceAccounts']));
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
      personalAccessTokens: 0,
      mfaResetRequests: 0,
      impersonationRequests: 0,
      // Service accounts are org property — the purge takes them and their keys.
      serviceAccounts: 1,
      serviceAccountKeys: 2,
    });
    expect(report.mongoFailures).toEqual([]);
    expect(mockSamlSessionDeleteMany).toHaveBeenCalledWith({ organizationId: 'org-acme' });
    // The live delete is exactly this org's own hash chain (chain key =
    // affectedOrgId). An event this org's members performed on ANOTHER org
    // (orgId = org-acme, affectedOrgId = other) is a link in THAT org's chain;
    // deleting it would break the other tenant's tamper-evidence.
    expect(mockAuditDeleteMany).toHaveBeenCalledWith({ affectedOrgId: 'org-acme' });
    // The archive still copies both sides.
    expect(mockAuditFind).toHaveBeenCalledWith({ $or: [{ orgId: 'org-acme' }, { affectedOrgId: 'org-acme' }] });

    // IdP cleanup scoped to the deleted org's id — orphaned configs were
    // the bug this guards against.
    expect(mockIdpDeleteMany).toHaveBeenCalledWith({ organizationId: 'org-acme' });
  });

  it('ARCHIVES the audit trail to archived_audit_events BEFORE deleting the live rows', async () => {
    const events = [
      { _id: 'evt-1', action: 'user.login', orgId: 'org-acme', createdAt: new Date('2026-11-01T00:00:00Z') },
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
    // Retention: an archived event expires when the live row would have —
    // createdAt + AUDIT_RETENTION_DAYS — never kept past it.
    expect(ops[0].replaceOne.replacement.expiresAt).toEqual(new Date('2027-01-30T00:00:00Z'));
    // No createdAt → the full window from the archive time.
    const archivedAt = ops[1].replaceOne.replacement.archivedAt as Date;
    expect(ops[1].replaceOne.replacement.expiresAt.getTime()).toBe(archivedAt.getTime() + 90 * 86_400_000);

    // Archive succeeded → live rows deleted → report flags the archive ok.
    expect(report.auditArchive).toEqual({ ok: true, archived: 2 });
    expect(report.mongo.auditEvents).toBe(2);
  });

  it('archivedAuditExpiry reads a string createdAt (lean rows from older drivers) too', () => {
    const at = new Date('2026-12-01T00:00:00Z');
    expect(archivedAuditExpiry({ createdAt: '2026-11-01T00:00:00Z' }, at)).toEqual(new Date('2027-01-30T00:00:00Z'));
    expect(archivedAuditExpiry({ createdAt: 'garbage' }, at)).toEqual(new Date(at.getTime() + 90 * 86_400_000));
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
    mockInvitationFind.mockReturnValue(findChain([{ email: 'foo@example.com' }]));
    mockAuditFind.mockReturnValue(auditCapped([{ action: 'user.login' }]));

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    // EVERY org-scoped table, whoever owns it — the export is read-only, so the
    // portability artifact / recovery snapshot still covers the whole org.
    expect(Object.keys(dump.postgres).length).toBe(EXPORT_TABLES.length);
    expect(Object.keys(dump.postgres)).toEqual(expect.arrayContaining(['pipelines', 'compliance_rules', 'messages', 'report_runs', 'dashboards']));
    expect(dump.mongo.invitations).toHaveLength(1);
    expect(dump.mongo.auditEvents).toHaveLength(1);
    expect(dump.orgId).toBe('org-acme');
    expect(dump.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /**
   * The Mongo twin of the CASCADE_TABLE_NAMES drift guard. An export carrying
   * less than the teardown removes (IdP config, group mappings, domains, join
   * requests, SAML sessions, service accounts + keys, memberships, Role
   * assignments, Roles) makes the soft-delete "recovery snapshot" unable to
   * restore an org, and the portability artifact under-report what the
   * platform holds.
   */
  it('DRIFT GUARD: every collection the teardown removes appears in the artifact', async () => {
    const dump = await exportOrg('org-acme', '000000000000000000000001');

    const missing = [...CASCADE_MONGO_COLLECTION_NAMES].filter((name) => !(name in dump.mongo));
    expect(missing).toEqual([]);
    // And the set names the collections beyond invitations + audit events.
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
    const select = jest.fn((..._args: unknown[]) => findChain([{ _id: 'k1' }]));
    mockServiceAccountFind.mockReturnValue(findChain([{ _id: 'sa-1' }]));
    mongoFinds.personalAccessToken.mockReturnValue({ select } as never);

    await exportOrg('org-acme', '000000000000000000000001');

    expect(select).toHaveBeenCalledWith('-keyHash');
  });

  it('never exports an invitation token hash (the plaintext token is never stored)', async () => {
    const select = jest.fn((..._args: unknown[]) => findChain([{ email: 'a@acme.test' }]));
    mockInvitationFind.mockReturnValue({ select } as never);

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    expect(select).toHaveBeenCalledWith('-tokenHash');
    expect(dump.mongo.invitations).toHaveLength(1);
  });

  it('never exports a runner signing key\'s private_key_enc (either spelling), keeping the rest of the row', async () => {
    const keyRow = {
      id: 'k1',
      kid: 'kid-1',
      state: 'active',
      publicJwk: { kty: 'OKP' },
      privateKeyEnc: '{"ct":"secret"}',
      private_key_enc: '{"ct":"secret"}',
    };
    const keyTable = ownership.allOrgScopedTables().find((t) => t.name === 'pipeline_runner_signing_keys')!.table;
    let current: unknown;
    mockSelectChain.from.mockImplementation((table: unknown) => { current = table; return mockSelectChain; });
    mockSelectChain.where.mockImplementation(async () => (current === keyTable ? [{ ...keyRow }] : [{ id: 'p1', name: 'other' }]));

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    const keys = dump.postgres.pipeline_runner_signing_keys as Record<string, unknown>[];
    expect(keys).toEqual([{ id: 'k1', kid: 'kid-1', state: 'active', publicJwk: { kty: 'OKP' } }]);
    const json = JSON.stringify(dump);
    expect(json).not.toContain('private_key_enc');
    expect(json).not.toContain('privateKeyEnc');
    // Tables without secret columns are untouched.
    expect(dump.postgres.pipelines).toEqual([{ id: 'p1', name: 'other' }]);
  });

  it('caps the audit read so one tenant cannot exhaust the heap', async () => {
    mockSelectChain.where.mockResolvedValue([]);
    mockInvitationFind.mockReturnValue(findChain([]));
    let applied = 0;
    mockAuditFind.mockReturnValue(auditCapped([{ action: 'user.login' }], (n) => { applied = n; }));

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    expect(applied).toBeGreaterThan(0);
    // Under the cap → a complete artifact, no truncation marker.
    expect(dump.truncated).toBeUndefined();
  });

  it('REPORTS truncation when the audit read fills the cap (never silently partial)', async () => {
    mockSelectChain.where.mockResolvedValue([]);
    mockInvitationFind.mockReturnValue(findChain([]));
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
    mockInvitationFind.mockReturnValue(findChain([]));
    mockAuditFind.mockReturnValue(auditCapped([]));
  };

  it('lenient (portability export): names every store it could not read instead of passing it off as empty', async () => {
    emptyReads();
    mockSelectChain.where.mockRejectedValueOnce(new Error('relation down'));
    mockInvitationFind.mockReturnValue({ lean: () => Promise.reject(new Error('mongo blip')) });

    const dump = await exportOrg('org-acme', '000000000000000000000001');

    const first = EXPORT_TABLES[0]!.name;
    expect(dump.failed).toEqual({ postgres: [first], mongo: ['invitations'] });
    expect(dump.postgres[first]).toEqual([]);
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
    // owned by SOME service's purge (platform's own, or a downstream outbox leg)
    // or it orphans on org purge + is missing from the GDPR export. A failure
    // here means: add the new table to its owner in pipeline-data's
    // ORG_DATA_OWNERSHIP.
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

  it('covers org_alert_rules and pipeline_templates', () => {
    expect(CASCADE_TABLE_NAMES.has('org_alert_rules')).toBe(true);
    expect(CASCADE_TABLE_NAMES.has('pipeline_templates')).toBe(true);
  });
});
