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
jest.unstable_mockModule('../src/models/subscription.js', () => ({
  Subscription: {
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
    findOne: (...a: unknown[]) => mockFindOne(...a),
  },
}));

const {
  grantSupportIncidents, consumeSupportIncident, refundSupportIncident,
  supportIncidentsRemaining, MAX_INCIDENT_GRANT,
} = await import('../src/helpers/support-incidents.js');

beforeEach(() => {
  mockFindOneAndUpdate.mockReset();
  mockFindOne.mockReset();
});

describe('grantSupportIncidents', () => {
  it('increments atomically and returns the new balance', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ supportIncidentBalance: 3 });
    await expect(grantSupportIncidents('org-1', 3)).resolves.toBe(3);

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

  it.each([0, -1, 1.5, MAX_INCIDENT_GRANT + 1, NaN])('rejects an out-of-range count: %p', async (count) => {
    await expect(grantSupportIncidents('org-1', count as number)).rejects.toThrow(/integer in 1\.\./);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('consumeSupportIncident', () => {
  it('guards the balance IN THE FILTER so a race cannot double-spend', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ supportIncidentBalance: 0 });
    await expect(consumeSupportIncident('org-1')).resolves.toBe(true);

    const [filter, update] = mockFindOneAndUpdate.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    // THE assertion: the >= 1 precondition is part of the atomic operation, not
    // a prior read. Without it, two concurrent opens on a balance of 1 both win.
    expect(filter).toMatchObject({ orgId: 'org-1', supportIncidentBalance: { $gte: 1 } });
    expect(update).toEqual({ $inc: { supportIncidentBalance: -1 } });
  });

  it('is false — not an exception — when the org has none', async () => {
    // The caller turns this into "you have no support entitlement", so a
    // missing balance is an ordinary answer rather than an error path.
    mockFindOneAndUpdate.mockResolvedValue(null);
    await expect(consumeSupportIncident('org-1')).resolves.toBe(false);
  });

  it('spends exactly one, never a variable amount', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ supportIncidentBalance: 4 });
    await consumeSupportIncident('org-1');
    const [, update] = mockFindOneAndUpdate.mock.calls[0] as [unknown, { $inc: { supportIncidentBalance: number } }];
    expect(update.$inc.supportIncidentBalance).toBe(-1);
  });
});

describe('refundSupportIncident', () => {
  it('is a distinct operation from a grant, so the two stay separately auditable', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ supportIncidentBalance: 2 });
    await expect(refundSupportIncident('org-1')).resolves.toBe(2);
    const [, update] = mockFindOneAndUpdate.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(update).toEqual({ $inc: { supportIncidentBalance: 1 } });
  });

  it('returns null with no manageable subscription', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    await expect(refundSupportIncident('ghost')).resolves.toBeNull();
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
