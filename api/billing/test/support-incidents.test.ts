// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * One-time support incidents: a consumable balance, not a quota.
 *
 * The assertions that matter are about the SHAPE of the mongo operations rather
 * than their results, because that shape is the correctness argument:
 *
 *  - grant/consume use `$inc`, never read-modify-write, so concurrent callers
 *    cannot lose an increment;
 *  - consume carries `supportIncidentBalance: { $gte: 1 }` in the FILTER, so two
 *    concurrent case opens against a balance of 1 cannot both succeed. Reading
 *    the balance and then decrementing would let both through — a free support
 *    case per race.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => undefined },
}));

const mockFindOneAndUpdate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockFindOne = jest.fn<(...a: unknown[]) => unknown>();
const mockUpdateOne = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  SUPPORT_INCIDENT_SPEND_HISTORY: 200,
  Subscription: {
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
    findOne: (...a: unknown[]) => mockFindOne(...a),
    updateOne: (...a: unknown[]) => mockUpdateOne(...a),
  },
}));

const {
  grantSupportIncidents, consumeSupportIncident, refundSupportIncident,
  supportIncidentsRemaining, MAX_INCIDENT_GRANT,
} = await import('../src/helpers/support-incidents.js');

beforeEach(() => {
  mockFindOneAndUpdate.mockReset();
  mockFindOne.mockReset();
  mockUpdateOne.mockReset();
});

describe('grantSupportIncidents', () => {
  it('increments atomically and returns the new balance', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ supportIncidentBalance: 3 });
    await expect(grantSupportIncidents('org-1', 3)).resolves.toEqual({ balance: 3, duplicate: false });

    const [filter, update, opts] = mockFindOneAndUpdate.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(filter).toMatchObject({ orgId: 'org-1' });
    // $inc, not a read-then-write: two concurrent grants must both land.
    expect(update).toEqual({ $inc: { supportIncidentBalance: 3 } });
    expect(opts).toMatchObject({ new: true });
  });

  it('only grants against a MANAGEABLE subscription', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ supportIncidentBalance: 1 });
    await grantSupportIncidents('org-1', 1);
    const [filter] = mockFindOneAndUpdate.mock.calls[0] as [{ status?: { $in?: string[] } }];
    expect(filter.status?.$in).toEqual(expect.arrayContaining(['active', 'trialing', 'past_due']));
  });

  it('returns null when there is no subscription to hold the balance', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    await expect(grantSupportIncidents('ghost', 1)).resolves.toBeNull();
  });

  // A grant is a POST an operator's browser (or a proxy) can retry. Without a
  // key the retry granted the incidents twice; with one, the key rides the same
  // atomic filter as the `$inc`, so a repeat — even a concurrent one — grants
  // nothing and answers with the balance as it stands.
  it('applies a keyed grant once: the key is guarded in the same atomic write as the $inc', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce({ supportIncidentBalance: 4 });
    await expect(grantSupportIncidents('org-1', 4, 'staff-1', 'grant-key-0001')).resolves.toEqual({ balance: 4, duplicate: false });
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0] as [Record<string, unknown>, Record<string, any>];
    expect(filter).toMatchObject({ 'supportIncidentGrants.key': { $ne: 'grant-key-0001' } });
    expect(update.$inc).toEqual({ supportIncidentBalance: 4 });
    expect(update.$push.supportIncidentGrants.$each).toEqual([expect.objectContaining({ key: 'grant-key-0001', count: 4 })]);
  });

  it('answers a repeated key with the current balance and grants nothing', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    mockFindOne.mockReturnValueOnce({ lean: async () => ({ supportIncidentBalance: 4 }) });
    await expect(grantSupportIncidents('org-1', 4, 'staff-1', 'grant-key-0001')).resolves.toEqual({ balance: 4, duplicate: true });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, MAX_INCIDENT_GRANT + 1, NaN])('rejects an out-of-range count: %p', async (count) => {
    await expect(grantSupportIncidents('org-1', count as number)).rejects.toThrow(/integer in 1\.\./);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const KEY = 'submission-0001';
const lean = (v: unknown) => ({ lean: () => Promise.resolve(v) });

describe('consumeSupportIncident', () => {
  it('guards the balance AND the key IN THE FILTER, recording the spend in the same write', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ supportIncidentBalance: 0 });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(true);

    const [filter, update] = mockFindOneAndUpdate.mock.calls[0] as [Record<string, unknown>, Record<string, any>];
    // THE assertion: the >= 1 precondition is part of the atomic operation, not
    // a prior read. Without it, two concurrent opens on a balance of 1 both win.
    // The key guard rides the same filter, so a duplicate of one key spends once.
    expect(filter).toMatchObject({
      'orgId': 'org-1',
      'supportIncidentBalance': { $gte: 1 },
      'supportIncidentSpends.key': { $ne: KEY },
    });
    expect(update.$inc).toEqual({ supportIncidentBalance: -1 });
    expect(update.$push.supportIncidentSpends.$each).toEqual([
      { key: KEY, consumed: true, refunded: false, at: expect.any(Date) },
    ]);
    // Bounded history — the array cannot grow without limit.
    expect(update.$push.supportIncidentSpends.$slice).toBeLessThan(0);
  });

  it('a REPEATED key answers its original outcome and spends nothing', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null); // key guard refused the spend
    mockFindOne.mockReturnValue(lean({ supportIncidentSpends: [{ key: KEY, consumed: true }] }));
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(true);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('is false — not an exception — when the org has none, and records that outcome under the key', async () => {
    // The caller turns this into "you have no support entitlement", so a
    // missing balance is an ordinary answer rather than an error path.
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindOne.mockReturnValue(lean(null));
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(false);
    const [filter, update] = mockUpdateOne.mock.calls[0] as [Record<string, unknown>, Record<string, any>];
    expect(filter).toMatchObject({ 'supportIncidentSpends.key': { $ne: KEY } });
    expect(update.$push.supportIncidentSpends.$each[0]).toMatchObject({ key: KEY, consumed: false });
  });

  it('reads the winner when a concurrent duplicate of the key recorded first', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindOne
      .mockReturnValueOnce(lean(null))
      .mockReturnValueOnce(lean({ supportIncidentSpends: [{ key: KEY, consumed: true }] }));
    mockUpdateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(consumeSupportIncident('org-1', KEY)).resolves.toBe(true);
  });

  it('is false with no manageable subscription at all', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFindOne.mockReturnValue(lean(null));
    mockUpdateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(consumeSupportIncident('ghost', KEY)).resolves.toBe(false);
  });

  it('spends exactly one, never a variable amount', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ supportIncidentBalance: 4 });
    await consumeSupportIncident('org-1', KEY);
    const [, update] = mockFindOneAndUpdate.mock.calls[0] as [unknown, { $inc: { supportIncidentBalance: number } }];
    expect(update.$inc.supportIncidentBalance).toBe(-1);
  });
});

describe('refundSupportIncident', () => {
  it('gives back only a spend that HAPPENED under the key, flagging it refunded in the same write', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ supportIncidentBalance: 2 });
    await expect(refundSupportIncident('org-1', KEY)).resolves.toEqual({ refunded: true, balance: 2 });
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(filter).toMatchObject({
      supportIncidentSpends: { $elemMatch: { key: KEY, consumed: true, refunded: { $ne: true } } },
    });
    // Distinct from a grant ($inc alone), so the two stay separately auditable.
    expect(update).toEqual({ $inc: { supportIncidentBalance: 1 }, $set: { 'supportIncidentSpends.$.refunded': true } });
  });

  it('is a no-op for a key never spent — and burns the key so a late consume cannot spend', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockFindOne.mockReturnValue(lean({ supportIncidentBalance: 3 }));
    await expect(refundSupportIncident('org-1', KEY)).resolves.toEqual({ refunded: false, balance: 3 });
    const [filter, update] = mockUpdateOne.mock.calls[0] as [Record<string, unknown>, Record<string, any>];
    expect(filter).toMatchObject({ 'supportIncidentSpends.key': { $ne: KEY } });
    expect(update.$push.supportIncidentSpends.$each[0]).toMatchObject({ key: KEY, consumed: false });
  });

  it('reports a null balance with no manageable subscription', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockUpdateOne.mockResolvedValue({ matchedCount: 0 });
    mockFindOne.mockReturnValue(lean(null));
    await expect(refundSupportIncident('ghost', KEY)).resolves.toEqual({ refunded: false, balance: null });
  });
});

describe('supportIncidentsRemaining', () => {
  it('reads the balance', async () => {
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve({ supportIncidentBalance: 7 }) });
    await expect(supportIncidentsRemaining('org-1')).resolves.toBe(7);
  });

  it('is 0 for an org with no subscription, not undefined', async () => {
    // Callers compare this against 1; `undefined` would make that comparison
    // silently false-y in the wrong direction on a refactor.
    mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(supportIncidentsRemaining('ghost')).resolves.toBe(0);
  });
});
