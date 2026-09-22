// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/quota-refund — a deleted version's `plugins` slot is
 * refunded CONDITIONALLY on the quota period it was charged to (W0.5): quota
 * is a per-period flow, so a refund must never land in a later period.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockDecrementQuota = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ decrementQuota: mockDecrementQuota }));

const { refundPluginSlot } = await import('../src/helpers/quota-refund.js');

const quotaService = { decrement: jest.fn<AnyFn>() } as any;
const logWarn = jest.fn<AnyFn>();

beforeEach(() => { jest.clearAllMocks(); });

describe('refundPluginSlot', () => {
  it('refunds with the charge-time resetAt as the conditional snapshot', () => {
    expect(refundPluginSlot(quotaService, { orgId: 'org-1', quotaResetAt: new Date('2026-09-24T00:00:00.000Z') }, logWarn)).toBe(true);
    expect(mockDecrementQuota).toHaveBeenCalledWith(
      quotaService, 'org-1', 'plugins', 'Bearer service-token', logWarn, 1, '2026-09-24T00:00:00.000Z',
    );
  });

  it('accepts the ISO string a cached row carries', () => {
    expect(refundPluginSlot(quotaService, { orgId: 'org-1', quotaResetAt: '2026-09-24T00:00:00.000Z' }, logWarn)).toBe(true);
    expect(mockDecrementQuota.mock.calls[0]![6]).toBe('2026-09-24T00:00:00.000Z');
  });

  it.each([[null], [undefined], ['not a date']])('refunds nothing without a usable snapshot (%p)', (quotaResetAt) => {
    expect(refundPluginSlot(quotaService, { orgId: 'org-1', quotaResetAt }, logWarn)).toBe(false);
    expect(mockDecrementQuota).not.toHaveBeenCalled();
  });
});
