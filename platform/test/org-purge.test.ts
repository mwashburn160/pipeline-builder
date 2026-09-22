// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the org purge sweep — the back half of soft-delete. It runs the
 * EXISTING fail-closed cascade + hard delete for every org whose `purgeAfter`
 * has lapsed. Fail-closed, idempotent, never throws.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { leaderLockMock } from './helpers/leader-lock-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { selectLean } from './helpers/query-chain.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ organization: { purgeSweepIntervalMs: 1000 }, audit: { retentionDays: 90 } }));

const mockOrgFind = jest.fn<AnyFn>();
const mockCascade = jest.fn<(...a: unknown[]) => Promise<any>>();
const mockDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockCreateEvent = jest.fn<(...a: unknown[]) => void>();

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  Organization: { find: (...a: unknown[]) => mockOrgFind(...a) },
}));
jest.unstable_mockModule('../src/services/org-cascade-service.js', () => ({
  cascadeDeleteOrg: (...a: unknown[]) => mockCascade(...a),
}));
jest.unstable_mockModule('../src/services/organization-service.js', () => ({
  organizationService: { delete: (...a: unknown[]) => mockDelete(...a) },
}));
// The purge records through the durable (spool-on-failure) local recorder.
jest.unstable_mockModule('../src/helpers/audit.js', () => ({
  recordAuditEvent: (...a: unknown[]) => mockCreateEvent(...a),
}));

jest.unstable_mockModule('../src/utils/leader-lock.js', () => leaderLockMock());

const { purgeExpiredOrgs, orgPurgeSweep } = await import('../src/services/org-purge.js');
const { buildSweep } = await import('../src/services/background-sweeps.js');

let sweep: { start(): void; stop(): void } | null = null;
function startOrgPurgeSweep(intervalMs: number): void {
  sweep ??= buildSweep(orgPurgeSweep(intervalMs));
  sweep!.start();
}
function stopOrgPurgeSweep(): void {
  sweep?.stop();
  sweep = null;
}

/** `Organization.find(...).select(...).lean()` chain returning `rows`. */
function okReport() {
  return { postgres: {}, mongo: {}, mongoFailures: [] as string[], quota: { ok: true }, billing: { ok: true }, auditArchive: { ok: true } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCascade.mockResolvedValue(okReport());
  mockDelete.mockResolvedValue(undefined);
  mockCreateEvent.mockReturnValue(undefined);
});
afterEach(() => stopOrgPurgeSweep());

describe('purgeExpiredOrgs', () => {
  it('scans for tombstoned orgs whose purgeAfter has lapsed', async () => {
    mockOrgFind.mockReturnValue(selectLean([]));
    await purgeExpiredOrgs();

    const filter = mockOrgFind.mock.calls[0][0] as any;
    expect(filter.deletedAt).toEqual({ $ne: null });
    expect(filter.purgeAfter).toEqual({ $lte: expect.any(Date) });
  });

  it('runs the cascade + hard delete for each expired org', async () => {
    mockOrgFind.mockReturnValue(selectLean([{ _id: 'org-a' }, { _id: 'org-b' }]));

    const res = await purgeExpiredOrgs();

    expect(mockCascade).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith('org-a');
    expect(mockDelete).toHaveBeenCalledWith('org-b');
    expect(res).toMatchObject({ scanned: 2, purged: 2, deferred: 0, failed: 0 });
  });

  it('writes an admin.org.delete audit event after each successful hard delete', async () => {
    mockOrgFind.mockReturnValue(selectLean([{ _id: 'org-a' }]));
    mockCascade.mockResolvedValue({
      ...okReport(),
      postgres: { pipelines: { ok: true, rowCount: 3 }, pipeline_events: { ok: true, rowCount: 0 } },
      mongo: { invitations: 2, auditEvents: 5, idpConfigs: 1 },
      auditArchive: { ok: true, archived: 5 },
      // A per-org KMS key was flagged — its keyRef (a key id/ARN that can embed
      // an AWS account id) must NOT surface in the audit details.
      kms: { flagged: true, keyRef: 'arn:aws:kms:us-east-1:123456789012:key/abcd' },
    });

    await purgeExpiredOrgs();

    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    const evt = mockCreateEvent.mock.calls[0][0] as any;
    expect(evt).toMatchObject({
      action: 'admin.org.delete',
      actorId: 'org-purge',
      affectedOrgId: 'org-a',
      outcome: 'success',
    });
    // Safe summary: counts + flags only.
    expect(evt.details).toMatchObject({
      trigger: 'purge-sweep',
      postgres: { pipelines: 3, pipeline_events: 0 },
      mongo: { invitations: 2, auditEvents: 5, idpConfigs: 1 },
      quotaOk: true,
      billingOk: true,
      auditArchived: 5,
      kmsOrphanFlagged: true,
    });
    // HARD RULE: no KMS key id / AWS account id ever lands in the audit trail.
    expect(JSON.stringify(evt.details)).not.toContain('arn:aws:kms');
    expect(JSON.stringify(evt.details)).not.toContain('123456789012');
  });

  it('does NOT audit admin.org.delete when the purge is deferred (fail-closed)', async () => {
    mockOrgFind.mockReturnValue(selectLean([{ _id: 'org-a' }]));
    mockCascade.mockResolvedValue({ ...okReport(), billing: { ok: false } });

    await purgeExpiredOrgs();

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('an audit-recorder failure never fails the purge (fire-and-forget)', async () => {
    mockOrgFind.mockReturnValue(selectLean([{ _id: 'org-a' }]));
    mockCreateEvent.mockImplementation(() => { throw new Error('audit store down'); });

    const res = await purgeExpiredOrgs();

    // A recorder that throws lands in the per-org catch AFTER the hard delete
    // committed; the delete itself stands.
    expect(mockDelete).toHaveBeenCalledWith('org-a');
    expect(res.scanned).toBe(1);
  });

  it('FAIL-CLOSED: defers the hard delete when ANY Postgres table failed to tear down', async () => {
    mockOrgFind.mockReturnValue(selectLean([{ _id: 'org-a' }]));
    mockCascade.mockResolvedValue({
      ...okReport(),
      postgres: { pipelines: { ok: true, rowCount: 3 }, pipeline_events: { ok: false, error: 'boom' } },
    });

    const res = await purgeExpiredOrgs();

    // Hard-deleting the org doc now would orphan pipeline_events forever —
    // nothing keys a retry off an org that no longer exists.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(res).toMatchObject({ purged: 0, deferred: 1 });
  });

  it('FAIL-CLOSED: defers the hard delete when a Mongo collection leg failed', async () => {
    mockOrgFind.mockReturnValue(selectLean([{ _id: 'org-a' }]));
    mockCascade.mockResolvedValue({ ...okReport(), mongoFailures: ['personalAccessTokens'] });

    const res = await purgeExpiredOrgs();

    expect(mockDelete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ purged: 0, deferred: 1 });
  });

  it('FAIL-CLOSED: defers the hard delete when a billing/quota leg failed', async () => {
    mockOrgFind.mockReturnValue(selectLean([{ _id: 'org-a' }]));
    mockCascade.mockResolvedValue({ ...okReport(), billing: { ok: false } });

    const res = await purgeExpiredOrgs();

    // Cascade ran, but the org was NOT hard-deleted — it stays soft-deleted and
    // retries next sweep (a live subscription must never outlive its org).
    expect(mockCascade).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ purged: 0, deferred: 1 });
  });

  it('FAIL-CLOSED: defers the hard delete when the audit-trail archive failed', async () => {
    mockOrgFind.mockReturnValue(selectLean([{ _id: 'org-a' }]));
    mockCascade.mockResolvedValue({ ...okReport(), auditArchive: { ok: false } });

    const res = await purgeExpiredOrgs();

    // Cascade ran, but the org was NOT hard-deleted — its audit rows weren't
    // archived, so destroying them (via the hard delete) is refused; retry next
    // sweep.
    expect(mockCascade).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ purged: 0, deferred: 1 });
  });

  it('is idempotent + resilient: one org failing does not abort the others', async () => {
    mockOrgFind.mockReturnValue(selectLean([{ _id: 'org-a' }, { _id: 'org-b' }]));
    mockCascade.mockImplementationOnce(() => Promise.reject(new Error('cascade boom')));

    const res = await purgeExpiredOrgs();

    // org-a threw; org-b still processed.
    expect(mockDelete).toHaveBeenCalledWith('org-b');
    expect(res).toMatchObject({ scanned: 2, purged: 1, failed: 1 });
  });

  it('never throws on a scan failure (logs, returns zeros)', async () => {
    mockOrgFind.mockReturnValue({ select: () => ({ lean: () => Promise.reject(new Error('mongo down')) }) });
    await expect(purgeExpiredOrgs()).resolves.toMatchObject({ scanned: 0, purged: 0 });
  });
});

describe('orgPurgeSweep', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('runs an immediate sweep and repeats on the interval', async () => {
    mockOrgFind.mockReturnValue(selectLean([]));
    startOrgPurgeSweep(1000);

    expect(mockOrgFind).toHaveBeenCalledTimes(1); // immediate
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockOrgFind).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — a second start does not add a second timer', async () => {
    mockOrgFind.mockReturnValue(selectLean([]));
    startOrgPurgeSweep(1000);
    startOrgPurgeSweep(1000);
    expect(mockOrgFind).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockOrgFind).toHaveBeenCalledTimes(2);
  });

  it('never overlaps itself: a sweep slower than the interval skips ticks (same-pod re-entrancy guard)', async () => {
    let release!: (rows: unknown[]) => void;
    const slow = new Promise<unknown[]>((r) => { release = r; });
    mockOrgFind.mockReturnValue({ select: () => ({ lean: () => slow }) });
    startOrgPurgeSweep(1000);
    await jest.advanceTimersByTimeAsync(3500);
    // Three ticks elapsed while the first sweep was still running — none started.
    expect(mockOrgFind).toHaveBeenCalledTimes(1);
    release([]);
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockOrgFind).toHaveBeenCalledTimes(2);
  });

  it('stop halts the interval', async () => {
    mockOrgFind.mockReturnValue(selectLean([]));
    startOrgPurgeSweep(1000);
    stopOrgPurgeSweep();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockOrgFind).toHaveBeenCalledTimes(1);
  });
});
