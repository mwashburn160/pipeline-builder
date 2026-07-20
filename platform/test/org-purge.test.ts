// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the org purge sweep — the back half of soft-delete. It runs the
 * EXISTING fail-closed cascade + hard delete for every org whose `purgeAfter`
 * has lapsed. Fail-closed, idempotent, never throws.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { organization: { purgeSweepIntervalMs: 1000 } },
}));

const mockOrgFind = jest.fn();
const mockCascade = jest.fn<(...a: unknown[]) => Promise<any>>();
const mockDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: { find: (...a: unknown[]) => mockOrgFind(...a) },
}));
jest.unstable_mockModule('../src/services/org-cascade-service.js', () => ({
  cascadeDeleteOrg: (...a: unknown[]) => mockCascade(...a),
}));
jest.unstable_mockModule('../src/services/organization-service.js', () => ({
  organizationService: { delete: (...a: unknown[]) => mockDelete(...a) },
}));

const { purgeExpiredOrgs, startOrgPurgeSweep, stopOrgPurgeSweep } = await import('../src/services/org-purge.js');

/** `Organization.find(...).select(...).lean()` chain returning `rows`. */
function findChain(rows: unknown[]) {
  return { select: () => ({ lean: () => Promise.resolve(rows) }) };
}
function okReport() {
  return { postgres: {}, mongo: {}, quota: { ok: true }, billing: { ok: true }, auditArchive: { ok: true } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCascade.mockResolvedValue(okReport());
  mockDelete.mockResolvedValue(undefined);
});
afterEach(() => stopOrgPurgeSweep());

describe('purgeExpiredOrgs', () => {
  it('scans for tombstoned orgs whose purgeAfter has lapsed', async () => {
    mockOrgFind.mockReturnValue(findChain([]));
    await purgeExpiredOrgs();

    const filter = mockOrgFind.mock.calls[0][0] as any;
    expect(filter.deletedAt).toEqual({ $ne: null });
    expect(filter.purgeAfter).toEqual({ $lte: expect.any(Date) });
  });

  it('runs the cascade + hard delete for each expired org', async () => {
    mockOrgFind.mockReturnValue(findChain([{ _id: 'org-a' }, { _id: 'org-b' }]));

    const res = await purgeExpiredOrgs();

    expect(mockCascade).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith('org-a');
    expect(mockDelete).toHaveBeenCalledWith('org-b');
    expect(res).toMatchObject({ scanned: 2, purged: 2, deferred: 0, failed: 0 });
  });

  it('FAIL-CLOSED: defers the hard delete when a billing/quota leg failed', async () => {
    mockOrgFind.mockReturnValue(findChain([{ _id: 'org-a' }]));
    mockCascade.mockResolvedValue({ ...okReport(), billing: { ok: false } });

    const res = await purgeExpiredOrgs();

    // Cascade ran, but the org was NOT hard-deleted — it stays soft-deleted and
    // retries next sweep (a live subscription must never outlive its org).
    expect(mockCascade).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res).toMatchObject({ purged: 0, deferred: 1 });
  });

  it('FAIL-CLOSED: defers the hard delete when the audit-trail archive failed', async () => {
    mockOrgFind.mockReturnValue(findChain([{ _id: 'org-a' }]));
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
    mockOrgFind.mockReturnValue(findChain([{ _id: 'org-a' }, { _id: 'org-b' }]));
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

describe('startOrgPurgeSweep', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs an immediate sweep and repeats on the interval', async () => {
    mockOrgFind.mockReturnValue(findChain([]));
    startOrgPurgeSweep(1000);

    expect(mockOrgFind).toHaveBeenCalledTimes(1); // immediate
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockOrgFind).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — a second start does not add a second timer', async () => {
    mockOrgFind.mockReturnValue(findChain([]));
    startOrgPurgeSweep(1000);
    startOrgPurgeSweep(1000);
    expect(mockOrgFind).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockOrgFind).toHaveBeenCalledTimes(2);
  });

  it('stop halts the interval', async () => {
    mockOrgFind.mockReturnValue(findChain([]));
    startOrgPurgeSweep(1000);
    stopOrgPurgeSweep();
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockOrgFind).toHaveBeenCalledTimes(1);
  });
});
