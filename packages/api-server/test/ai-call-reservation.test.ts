// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * withAiCallReservation / reserveAiCallSlot: resolve the model FIRST, then
 * reserve its weight — or waive the slot (BYOK, impersonation, weight 0) — with
 * route + feature + model + key-source attribution, and report tokens after.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
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

const { withAiCallReservation, reserveAiCallSlot } = await import('../src/api/ai-call-reservation.js');

const GRANTED = { exceeded: false, quota: { type: 'aiCalls', limit: 10, used: 1, remaining: 9, resetAt: '2026-10-01T00:00:00Z' } };
const PLATFORM = { provider: 'anthropic', modelId: 'claude-opus-4-1', keySource: 'platform' as const };
const mockReport = jest.fn<AnyFn>();

function req(user: Record<string, unknown> = { sub: 'u1', principalType: 'user' }) {
  return { method: 'POST', baseUrl: '/ask', route: { path: '/' }, params: {}, headers: {}, user } as never;
}
const opts = (over: Record<string, unknown> = {}) => ({
  quotaService: { reportUsage: mockReport } as never,
  orgId: 'org-1',
  serviceName: 'ask',
  logWarn: jest.fn(),
  feature: 'ask' as const,
  req: req(),
  ...over,
});

describe('withAiCallReservation', () => {
  beforeEach(() => {
    mockReserveQuota.mockReset().mockResolvedValue(GRANTED);
    mockDecrementQuota.mockReset();
    mockSendDenied.mockReset();
    mockReport.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { delete process.env.AI_MODEL_WEIGHTS; });

  it('resolves BEFORE reserving, and reserves the model weight with full attribution', async () => {
    process.env.AI_MODEL_WEIGHTS = '{"opus": 3}';
    const order: string[] = [];
    mockReserveQuota.mockImplementation(async () => { order.push('reserve'); return GRANTED; });
    const out = await withAiCallReservation({ ...opts(), resolve: async () => { order.push('resolve'); return PLATFORM; } }, async (slot, sel) => {
      expect(sel).toBe(PLATFORM);
      expect(slot.amount).toBe(3);
      expect(slot.waived).toBeUndefined();
      return 'ok';
    });
    expect(out).toEqual({ status: 'done', value: 'ok' });
    expect(order).toEqual(['resolve', 'reserve']);
    const [, org, type, , amount, attribution] = mockReserveQuota.mock.calls[0]!;
    expect([org, type, amount]).toEqual(['org-1', 'aiCalls', 3]);
    expect(attribution).toMatchObject({ route: 'POST /ask/', principalId: 'u1', principalType: 'user', feature: 'ask', model: 'claude-opus-4-1', keySource: 'platform' });
  });

  it.each([
    ['org key (BYOK)', { ...PLATFORM, keySource: 'org' as const }, req(), 'byok'],
    ['request key (BYOK)', { ...PLATFORM, keySource: 'request' as const }, req(), 'byok'],
    ['impersonation session', PLATFORM, req({ sub: 'u1', impersonatorId: 'staff-1' }), 'impersonation'],
    ['weight-0 self-hosted model', { provider: 'openai-compatible', modelId: 'qwen3', keySource: 'platform' as const }, req(), 'unweighted'],
  ])('waives the slot for a %s — no reservation, still reported with tokens', async (_label, selection, request, reason) => {
    await withAiCallReservation({ ...opts({ req: request }), resolve: async () => selection }, async (slot) => {
      expect(slot.waived).toBe(reason);
      expect(slot.amount).toBe(0);
      slot.markConsumed();
      slot.refund();
      slot.reportUsage({ inputTokens: 10, outputTokens: 5 });
      slot.reportUsage({ inputTokens: 99, outputTokens: 99 }); // once only
    });
    expect(mockReserveQuota).not.toHaveBeenCalled();
    expect(mockDecrementQuota).not.toHaveBeenCalled();
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith('org-1', 'aiCalls', 'Bearer svc-ask', { tokensIn: 10, tokensOut: 5 }, expect.objectContaining({ keySource: selection.keySource, feature: 'ask' }));
  });

  it('a resolution failure goes to onError with no slot taken', async () => {
    const onError = jest.fn<(e: unknown) => void>();
    const out = await withAiCallReservation({ ...opts(), resolve: async () => { throw new Error('AI off'); } }, async () => 'never', onError);
    expect(out).toMatchObject({ status: 'failed' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(mockReserveQuota).not.toHaveBeenCalled();
  });

  it('refunds the weighted amount (with attribution) when the body fails before contact', async () => {
    process.env.AI_MODEL_WEIGHTS = '{"opus": 2}';
    await withAiCallReservation({ ...opts(), resolve: async () => PLATFORM }, async () => { throw new Error('x'); }, jest.fn<(e: unknown) => void>());
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockDecrementQuota.mock.calls[0]![5]).toBe(2);
    expect(mockDecrementQuota.mock.calls[0]![7]).toMatchObject({ feature: 'ask' });
  });

  it('a denied reservation is answered on res and never runs the body', async () => {
    mockReserveQuota.mockResolvedValue({ exceeded: true, code: 'AI_MEMBER_SHARE_EXCEEDED', quota: GRANTED.quota });
    const body = jest.fn(async () => undefined);
    const out = await withAiCallReservation({ ...opts({ res: {} }), resolve: async () => PLATFORM }, body);
    expect(out).toMatchObject({ status: 'denied' });
    expect(mockSendDenied).toHaveBeenCalledTimes(1);
    expect(body).not.toHaveBeenCalled();
  });
});

describe('reserveAiCallSlot (a slot the caller settles)', () => {
  beforeEach(() => {
    mockReserveQuota.mockReset().mockResolvedValue(GRANTED);
    mockDecrementQuota.mockReset();
    mockReport.mockReset().mockResolvedValue(undefined);
  });

  it('scheduled work: explicit attribution, no request', async () => {
    const attribution = { principalType: 'user' as const, principalId: 'owner-1', route: 'schedule:report-summary' };
    const r = await reserveAiCallSlot({ ...opts({ req: undefined, feature: 'report-summary', attribution }) }, PLATFORM);
    expect(r.status).toBe('reserved');
    expect(mockReserveQuota.mock.calls[0]![5]).toEqual({ ...attribution, feature: 'report-summary', model: 'claude-opus-4-1', keySource: 'platform' });
  });

  it('keeps the slot once consumed; an uncontacted call with no tokens reports nothing', async () => {
    const r = await reserveAiCallSlot(opts(), PLATFORM);
    if (r.status !== 'reserved') throw new Error('expected a slot');
    r.slot.refund();
    r.slot.reportUsage(undefined);
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
    expect(mockReport).not.toHaveBeenCalled();

    const kept = await reserveAiCallSlot(opts(), PLATFORM);
    if (kept.status !== 'reserved') throw new Error('expected a slot');
    kept.slot.markConsumed();
    kept.slot.refund();
    expect(mockDecrementQuota).toHaveBeenCalledTimes(1);
  });
});
