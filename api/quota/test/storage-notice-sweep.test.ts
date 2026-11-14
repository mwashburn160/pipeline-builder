// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The storage threshold-notice sweep.
 *
 * It exists because `storageBytes` is measured rather than incremented, so the
 * notifier every other quota reaches on its increment was never reached for it
 * — no proactive storage notice was ever sent, on any tier. These tests pin the
 * four things that make the sweep safe, each of which has a real failure mode:
 *
 *  1. an UNKNOWN reading never notifies (otherwise a registry outage mails the
 *     entire customer base);
 *  2. an unlimited org is skipped rather than divided by;
 *  3. a stock has no period, so claims key on a reminder WINDOW — and dropping
 *     below a band clears them so refilling notifies promptly;
 *  4. one org's failure does not end the pass.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const emitCounter = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ emitCounter }));

// The sweep measures the ACCOUNT's total (the pool root's whole subtree), not
// one namespace — the limit is pooled at the root and the dashboard already
// reports the subtree against it, so a notice measured on one namespace would
// disagree with the figure the recipient is looking at.
const fetchStorageBytes = jest.fn<(orgIds: string[]) => Promise<number | null>>();
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({ fetchStorageBytes }));

const expandOrgScope = jest.fn<(orgId: string) => Promise<string[]>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ expandOrgScope }));

// The limit resolves the way the read path does: an explicit per-org cap, else
// the tier default. A fleet mostly has no explicit cap.
const defaultLimitFor = jest.fn<(tier: string | undefined, t: string) => number>();
jest.unstable_mockModule('../src/helpers/quota-helpers.js', () => ({ defaultLimitFor }));

const notifyThresholds = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/threshold-notifier.js', () => ({ notifyThresholds }));

const setGauge = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { setGauge }));

const aggregate = jest.fn<(pipeline: unknown[]) => Promise<Array<{ _id: { tier?: string; cap?: number }; n: number }>>>();
const deleteMany = jest.fn<AnyFn>();
const lean = jest.fn<AnyFn>();
const limit = jest.fn<(n: number) => { lean: typeof lean }>(() => ({ lean }));
const skip = jest.fn<(n: number) => { limit: typeof limit }>(() => ({ limit }));
const sort = jest.fn<(spec: unknown) => { skip: typeof skip }>(() => ({ skip }));
// Typed with its arguments so the assertion on the QUERY typechecks: the query
// must select live account roots, not every org.
const find = jest.fn<(query: unknown, projection: unknown) => { sort: typeof sort }>(() => ({ sort }));
jest.unstable_mockModule('../src/models/quota-notice.js', () => ({
  QuotaNotice: { deleteMany },
  QUOTA_NOTICE_THRESHOLDS: [80, 100] as const,
}));
jest.unstable_mockModule('../src/models/organization.js', () => ({ Organization: { find, aggregate } }));
jest.unstable_mockModule('../src/config.js', () => ({ config: { quota: { thresholdNoticesEnabled: true } } }));

const { sweepStorageNotices, storageBand, stockNoticeWindow, reportStorageCommitment } = await import('../src/services/storage-notice-sweep.js');

const GB = 1024 ** 3;
const DAY = 86_400_000;
const orgs = (rows: Array<{ id: string; limit?: number; tier?: string }>) =>
  lean.mockResolvedValue(rows.map((r) => ({
    _id: r.id,
    tier: r.tier ?? 'pro',
    ...(r.limit === undefined ? {} : { quotas: { storageBytes: r.limit } }),
  })));

beforeEach(() => {
  jest.clearAllMocks();
  deleteMany.mockReset();
  deleteMany.mockResolvedValue({ deletedCount: 0 });
  expandOrgScope.mockImplementation(async (orgId) => [orgId]);
  defaultLimitFor.mockReturnValue(25 * GB);
});

const sweep = () => sweepStorageNotices({ maxOrgs: 100, reminderMs: 7 * DAY });

describe('storageBand', () => {
  it('reports the HIGHEST band reached, so a full org is told it is full', () => {
    expect(storageBand(1 * GB, 25 * GB)).toBeNull();
    expect(storageBand(20 * GB, 25 * GB)).toBe(80);
    expect(storageBand(25 * GB, 25 * GB)).toBe(100);
    expect(storageBand(30 * GB, 25 * GB)).toBe(100);
  });

  it('has no band for an unlimited or zero cap', () => {
    // -1 is unlimited (no percentage exists); 0 is a deliberate refusal.
    expect(storageBand(500, -1)).toBeNull();
    expect(storageBand(500, 0)).toBeNull();
  });
});

describe('stockNoticeWindow', () => {
  it('changes only when the reminder window rolls over', () => {
    const a = stockNoticeWindow(7 * DAY, 0);
    expect(stockNoticeWindow(7 * DAY, 6 * DAY)).toBe(a);
    expect(stockNoticeWindow(7 * DAY, 8 * DAY)).not.toBe(a);
  });
});

describe('sweepStorageNotices', () => {
  it('sweeps ACCOUNT ROOTS only, and measures the whole pool', async () => {
    // A team's own limits are -1 by design (the caps are pooled at its root), so
    // a team has no percentage of its own to cross and the query excludes it.
    orgs([{ id: 'root-1', limit: 25 * GB }]);
    expandOrgScope.mockResolvedValue(['root-1', 'team-a', 'team-b']);
    fetchStorageBytes.mockResolvedValue(21 * GB);

    const r = await sweep();
    expect(r).toEqual({ considered: 1, unknown: 0, notified: 1, cleared: 0 });
    expect(find).toHaveBeenCalledWith({ parentOrgId: null, deletedAt: null }, expect.anything());
    expect(fetchStorageBytes).toHaveBeenCalledWith(['root-1', 'team-a', 'team-b']);
    expect(notifyThresholds).toHaveBeenCalledWith(expect.objectContaining({
      rootOrgId: 'root-1',
      quotaType: 'storageBytes',
      limit: 25 * GB,
      used: 21 * GB,
      // Zero: this is a MEASUREMENT, not a write, so every band at or below the
      // reading is reported rather than only one freshly crossed.
      amount: 0,
      // `sweep` is what lets a storage notice through at all — the notifier
      // refuses a measured quota arriving from the increment path.
      source: 'sweep',
    }));
  });

  it('NEVER notifies on an unknown reading', async () => {
    // `null` means the registry was unreachable or answered malformed — not 0
    // and not full. Notifying here would mail every customer during an outage.
    orgs([{ id: 'org-1', limit: 25 * GB }]);
    fetchStorageBytes.mockResolvedValue(null);

    const r = await sweep();
    expect(r).toEqual({ considered: 1, unknown: 1, notified: 0, cleared: 0 });
    expect(notifyThresholds).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(emitCounter).toHaveBeenCalledWith('quota_storage_sweep_orgs_total', { outcome: 'unknown' });
  });

  it('skips an org whose storage limit is unlimited or a deliberate zero', async () => {
    orgs([{ id: 'org-1', limit: -1 }, { id: 'org-2', limit: 0 }]);
    const r = await sweep();
    expect(r.considered).toBe(0);
    expect(fetchStorageBytes).not.toHaveBeenCalled();
  });

  it('sweeps an org with NO explicit cap, which takes the tier default', async () => {
    // A first draft of the query required `quotas.storageBytes` to exist and
    // would therefore have swept almost nobody — the exact silent no-op this
    // whole plan exists to remove.
    orgs([{ id: 'org-1', tier: 'developer' }]);
    defaultLimitFor.mockReturnValue(2 * GB);
    fetchStorageBytes.mockResolvedValue(1.9 * GB);

    const r = await sweep();
    expect(r.notified).toBe(1);
    expect(defaultLimitFor).toHaveBeenCalledWith('developer', 'storageBytes');
  });

  it('clears an account\'s claims once it drops below every band', async () => {
    // A stock has no period to expire a claim, so freeing space has to clear it
    // — otherwise filling up again would stay silent until the reminder window.
    orgs([{ id: 'org-1', limit: 25 * GB }]);
    fetchStorageBytes.mockResolvedValue(5 * GB);
    deleteMany.mockResolvedValue({ deletedCount: 2 });

    const r = await sweep();
    expect(r).toEqual({ considered: 1, unknown: 0, notified: 0, cleared: 1 });
    expect(deleteMany).toHaveBeenCalledWith({ rootOrgId: 'org-1', quotaType: 'storageBytes' });
    expect(notifyThresholds).not.toHaveBeenCalled();
  });

  it('drops only the claims ABOVE the current band when usage falls part-way', async () => {
    // Fell from full back to 85%: the 100% claim goes, so refilling is reported
    // again, while the 80% claim stays so nobody is re-told what they know.
    orgs([{ id: 'org-1', limit: 25 * GB }]);
    fetchStorageBytes.mockResolvedValue(21 * GB);

    await sweep();
    expect(deleteMany).toHaveBeenCalledWith({
      rootOrgId: 'org-1', quotaType: 'storageBytes', threshold: { $gt: 80 },
    });
  });

  it('keeps going when one org fails', async () => {
    orgs([{ id: 'bad', limit: 25 * GB }, { id: 'good', limit: 25 * GB }]);
    fetchStorageBytes.mockImplementation(async (ids) => {
      if (ids[0] === 'bad') throw new Error('boom');
      return 25 * GB;
    });

    const r = await sweep();
    expect(r.notified).toBe(1);
    expect(emitCounter).toHaveBeenCalledWith('quota_storage_sweep_orgs_total', { outcome: 'failed' });
  });

  it('never sweeps a SOFT-DELETED account', async () => {
    // A soft-deleted root stays in the shared collection until platform's purge;
    // the query used to be `{ parentOrgId: null }` alone, so a deleted
    // account's admins could be mailed that its registry was full.
    orgs([]);
    await sweep();
    expect(find.mock.calls[0]![0]).toMatchObject({ deletedAt: null });
  });

  it('ROTATES through the fleet instead of re-reading the same first slice', async () => {
    // The pass is bounded by `maxOrgs`. With no cursor every pass read the same
    // first N roots, so an account past them was never swept at all.
    const pass = () => sweepStorageNotices({ maxOrgs: 2, reminderMs: 7 * DAY });
    fetchStorageBytes.mockResolvedValue(0);

    orgs([{ id: 'a', limit: 25 * GB }, { id: 'b', limit: 25 * GB }]);
    await pass();
    orgs([{ id: 'c', limit: 25 * GB }]); // a short page: the end of the fleet
    await pass();
    orgs([{ id: 'a', limit: 25 * GB }, { id: 'b', limit: 25 * GB }]);
    await pass();

    // Stable `_id` order, so the offsets name disjoint slices.
    expect(sort).toHaveBeenCalledWith({ _id: 1 });
    expect(skip.mock.calls.map((c) => c[0])).toEqual([0, 2, 0]);
  });

  it('stops between orgs when the leader lock is lost', async () => {
    orgs([{ id: 'a', limit: 25 * GB }, { id: 'b', limit: 25 * GB }]);
    fetchStorageBytes.mockResolvedValue(25 * GB);
    let seen = 0;
    await sweepStorageNotices({
      maxOrgs: 100,
      reminderMs: 7 * DAY,
      // Aborts after the first org: past a lock loss another pod may be sending
      // the same notices.
      shouldStop: () => seen++ > 0,
    });
    expect(notifyThresholds).toHaveBeenCalledTimes(1);
  });
});


/**
 * `reportStorageCommitment` — the numerator of
 * `StorageCommitmentExceedsCapacity`, which asks whether the platform can still
 * honour the storage it has SOLD. Every other storage alert fires when a disk is
 * already filling; this one fires months earlier, so the figure has to be exact.
 */
describe('reportStorageCommitment', () => {
  it('sums every root\'s EFFECTIVE cap, explicit or tier-default', async () => {
    defaultLimitFor.mockImplementation((tier) => (tier === 'developer' ? 2 * GB : 25 * GB));
    aggregate.mockResolvedValue([
      // No explicit cap → the tier default, × the number of orgs in the bucket.
      { _id: { tier: 'developer' }, n: 10 },
      { _id: { tier: 'pro' }, n: 4 },
      // An operator override wins over the tier default.
      { _id: { tier: 'pro', cap: 100 * GB }, n: 2 },
    ]);

    const r = await reportStorageCommitment();
    expect(r.committedBytes).toBe((10 * 2 + 4 * 25 + 2 * 100) * GB);
    expect(setGauge).toHaveBeenCalledWith('quota_storage_committed_bytes', {}, (10 * 2 + 4 * 25 + 2 * 100) * GB);
  });

  it('counts UNLIMITED roots separately instead of folding them in', async () => {
    // A -1 cap commits an unmeasurable amount, not a large one. Summing it as
    // anything would be a made-up number; excluding it silently would hide that
    // the real commitment is bigger than the gauge says.
    aggregate.mockResolvedValue([
      { _id: { tier: 'pro', cap: 25 * GB }, n: 2 },
      { _id: { tier: 'unlimited', cap: -1 }, n: 3 },
    ]);

    const r = await reportStorageCommitment();
    expect(r).toEqual({ committedBytes: 50 * GB, unlimitedOrgs: 3 });
    expect(setGauge).toHaveBeenCalledWith('quota_storage_unlimited_orgs', {}, 3);
  });

  it('commits nothing for a deliberate 0 cap', async () => {
    // 0 is a refusal ("no storage"), not a budget — and not unlimited either.
    aggregate.mockResolvedValue([{ _id: { tier: 'pro', cap: 0 }, n: 5 }]);
    expect(await reportStorageCommitment()).toEqual({ committedBytes: 0, unlimitedOrgs: 0 });
  });

  it('asks the database for ROOTS only, grouped so the query stays O(tiers)', async () => {
    // Account roots, because a team's caps are its root's. Grouped rather than
    // listed because this must cover the WHOLE fleet — the notice sweep's
    // `maxOrgs` bound would under-state the figure, and an alert built on an
    // under-stated numerator would never fire.
    aggregate.mockResolvedValue([]);
    await reportStorageCommitment();
    expect(aggregate).toHaveBeenCalledWith([
      // Live roots: a soft-deleted account awaiting purge has sold nobody anything.
      { $match: { parentOrgId: null, deletedAt: null } },
      { $group: { _id: { tier: '$tier', cap: '$quotas.storageBytes' }, n: { $sum: 1 } } },
    ]);
  });
});
