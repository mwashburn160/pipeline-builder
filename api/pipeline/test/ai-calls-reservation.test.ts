// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * withAiCallsReservation encapsulates the single aiCalls settlement rule every
 * /generate* route shares: keep the slot once the provider was contacted;
 * refund only if it never was. Only the quota transport (api-core's
 * reserve/decrement S2S calls) is mocked — the settlement logic is real.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockReserveQuota = jest.fn<(...a: any[]) => Promise<any>>();
const mockDecrementQuota = jest.fn();
const mockSendDenied = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  reserveQuota: (...a: unknown[]) => mockReserveQuota(...a),
  decrementQuota: (...a: unknown[]) => mockDecrementQuota(...a),
  sendQuotaReserveDenied: (...a: unknown[]) => mockSendDenied(...a),
}));

const { withAiCallsReservation } = await import('../src/helpers/ai-calls-reservation.js');

const GRANTED = { exceeded: false, quota: { type: 'aiCalls', limit: 10, used: 1, remaining: 9, resetAt: '2026-10-01T00:00:00Z' } };
const args = () => ({ quotaService: {} as any, orgId: 'org-1', res: {} as any, logWarn: jest.fn() });

describe('withAiCallsReservation', () => {
  beforeEach(() => {
    mockReserveQuota.mockReset().mockResolvedValue(GRANTED);
    mockDecrementQuota.mockReset();
    mockSendDenied.mockReset();
  });

  it('answers a denied reservation and never runs the body', async () => {
    mockReserveQuota.mockResolvedValue({ exceeded: true, quota: GRANTED.quota });
    const body = jest.fn(async () => undefined);
    await withAiCallsReservation(args(), body, jest.fn());
    expect(mockSendDenied).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveBeenCalled();
  });

  it('reserves with a service token, not the user bearer', async () => {
    await withAiCallsReservation(args(), async () => undefined, jest.fn());
    expect(mockReserveQuota).toHaveBeenCalledWith(expect.anything(), 'org-1', 'aiCalls', 'Bearer service-token');
  });

  it('keeps the slot on success', async () => {
    await withAiCallsReservation(args(), async () => undefined, jest.fn());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('refunds (with the reserved resetAt) when the body fails before the provider was contacted', async () => {
    const onError = jest.fn();
    const err = new Error('model not configured');
    await withAiCallsReservation(args(), async () => { throw err; }, onError);
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockDecrementQuota).toHaveBeenCalledWith(
      expect.anything(), 'org-1', 'aiCalls', 'Bearer service-token', expect.any(Function), 1, GRANTED.quota.resetAt,
    );
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('keeps the slot when the body fails AFTER markProviderContacted (mid-stream failure)', async () => {
    const onError = jest.fn();
    await withAiCallsReservation(args(), async (slot) => { slot.markProviderContacted(); throw new Error('stream broke'); }, onError);
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('keeps the slot when the error itself says the provider was contacted (AIEmptyOutputError)', async () => {
    const err = Object.assign(new Error('empty output'), { providerContacted: true });
    await withAiCallsReservation(args(), async () => { throw err; }, jest.fn());
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });

  it('an explicit refund() settles the slot at most once, even if the body then throws', async () => {
    await withAiCallsReservation(args(), async (slot) => { slot.refund(); slot.refund(); throw new Error('late'); }, jest.fn());
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
  });
});
