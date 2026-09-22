// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * withQuotaReservation: reserve → run → settle by one rule (keep the slot once
 * consumed, refund if the body fails first). Only the quota transport is mocked.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockReserveQuota = jest.fn<AnyFn>();
const mockDecrementQuota = jest.fn<AnyFn>();
const mockSendDenied = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  reserveQuota: (...a: unknown[]) => mockReserveQuota(...a),
  decrementQuota: (...a: unknown[]) => mockDecrementQuota(...a),
  sendQuotaReserveDenied: (...a: unknown[]) => mockSendDenied(...a),
  getServiceAuthHeader: (o: { serviceName: string }) => `Bearer svc-${o.serviceName}`,
}));

const { withQuotaReservation } = await import('../src/api/quota-reservation.js');

const GRANTED = { exceeded: false, quota: { type: 'aiCalls', limit: 10, used: 1, remaining: 9, resetAt: '2026-10-01T00:00:00Z' } };
const opts = (over: Record<string, unknown> = {}) => ({
  quotaService: {} as never, orgId: 'org-1', type: 'aiCalls' as const, serviceName: 'pipeline', logWarn: jest.fn(), ...over,
});

describe('withQuotaReservation', () => {
  beforeEach(() => {
    mockReserveQuota.mockReset().mockResolvedValue(GRANTED);
    mockDecrementQuota.mockReset();
    mockSendDenied.mockReset();
  });

  it('a denied reservation never runs the body; answered only when res is given', async () => {
    mockReserveQuota.mockResolvedValue({ exceeded: true, quota: GRANTED.quota });
    const body = jest.fn(async () => undefined);
    await expect(withQuotaReservation(opts(), body)).resolves.toMatchObject({ status: 'denied' });
    expect(mockSendDenied).not.toHaveBeenCalled();
    await withQuotaReservation(opts({ res: {} }), body);
    expect(mockSendDenied).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveBeenCalled();
  });

  it('reserves with a service token and keeps the slot on success', async () => {
    const out = await withQuotaReservation(opts(), async (slot) => slot.serviceAuth);
    expect(out).toEqual({ status: 'done', value: 'Bearer svc-pipeline' });
    expect(mockReserveQuota).toHaveBeenCalledWith({}, 'org-1', 'aiCalls', 'Bearer svc-pipeline');
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('refunds (with the reserved resetAt) and rethrows when the body fails before consumption', async () => {
    const err = new Error('boom');
    await expect(withQuotaReservation(opts(), async () => { throw err; })).rejects.toBe(err);
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockDecrementQuota.mock.calls[0]![6]).toBe(GRANTED.quota.resetAt);
  });

  it('keeps the slot when consumed (marked, or signalled by the error)', async () => {
    const onError = jest.fn<(e: unknown) => void>();
    await withQuotaReservation(opts(), async (slot) => { slot.markConsumed(); throw new Error('late'); }, onError);
    await withQuotaReservation(opts(), async () => { throw Object.assign(new Error('empty'), { providerContacted: true }); }, onError);
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('routes a failure to onError instead of rethrowing', async () => {
    const onError = jest.fn<(e: unknown) => void>();
    const out = await withQuotaReservation(opts(), async () => { throw new Error('x'); }, onError);
    expect(out).toMatchObject({ status: 'failed' });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('refund is idempotent', async () => {
    await withQuotaReservation(opts(), async (slot) => { slot.refund(); slot.refund(); throw new Error('late'); }, jest.fn<(e: unknown) => void>());
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
  });
});
