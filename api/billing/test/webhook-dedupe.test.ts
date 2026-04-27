// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the webhook-dedupe idempotency primitive.
 *
 * `claimWebhookEvent(source, eventId)` is the gate every webhook handler runs
 * before applying side-effects. Correctness here = no duplicate billing
 * mutations on SNS/Stripe redelivery. Worth verifying both the happy paths
 * and the duplicate-key short-circuit explicitly.
 */

const mockCreate = jest.fn();

jest.mock('mongoose', () => {
  return {
    Schema: class {
      index(): void { /* no-op */ }
    },
    models: {} as Record<string, unknown>,
    model: () => ({ create: (...args: unknown[]) => mockCreate(...args) }),
  };
});

import { claimWebhookEvent } from '../src/models/webhook-dedupe';

describe('claimWebhookEvent', () => {
  beforeEach(() => mockCreate.mockReset());

  it('returns true on first claim for a (source, eventId) pair', async () => {
    mockCreate.mockResolvedValue({ source: 'sns', eventId: 'evt-1' });
    const result = await claimWebhookEvent('sns', 'evt-1');
    expect(result).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith({ source: 'sns', eventId: 'evt-1' });
  });

  it('returns false when the same (source, eventId) is claimed twice', async () => {
    // Mongo unique-violation surfaces as { code: 11000 } — that's our signal.
    const dupeErr = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    mockCreate.mockRejectedValue(dupeErr);
    const result = await claimWebhookEvent('stripe', 'evt_test_123');
    expect(result).toBe(false);
  });

  it('rethrows non-duplicate errors so transport failures are visible', async () => {
    mockCreate.mockRejectedValue(new Error('connection lost'));
    await expect(claimWebhookEvent('sns', 'evt-x')).rejects.toThrow('connection lost');
  });

  it('treats different sources with the same eventId as independent', async () => {
    // Two separate inserts — both succeed because the unique key includes source.
    mockCreate.mockResolvedValueOnce({ source: 'sns', eventId: 'shared' });
    mockCreate.mockResolvedValueOnce({ source: 'stripe', eventId: 'shared' });
    expect(await claimWebhookEvent('sns', 'shared')).toBe(true);
    expect(await claimWebhookEvent('stripe', 'shared')).toBe(true);
    expect(mockCreate).toHaveBeenNthCalledWith(1, { source: 'sns', eventId: 'shared' });
    expect(mockCreate).toHaveBeenNthCalledWith(2, { source: 'stripe', eventId: 'shared' });
  });
});
