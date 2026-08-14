// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the webhook-dedupe idempotency primitive.
 *
 * `claimWebhookEvent` is the gate every webhook handler runs before applying
 * side-effects; `markWebhookEventDone` promotes that claim to a durable marker
 * only after success; `releaseWebhookEvent` frees a handled failure for retry.
 * Correctness here = no duplicate billing mutations on SNS/Stripe redelivery AND
 * no permanently-stranded marker when a handler crashes mid-process (the
 * two-phase crash-durability property).
 *
 * A shared in-memory store models the unique (source, eventId) collection so the
 * upsert/duplicate-key/TTL semantics can be exercised without a live Mongo. A
 * crash is simulated by expiring the in-progress lease (setting `expireAt` into
 * the past) — exactly what Mongo's per-doc TTL does after a process death.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Shared store the mongoose mock reads/writes — the test manipulates it directly
// to simulate lease expiry. Keyed by `${source}:${eventId}`.
const store = new Map<string, any>();

jest.unstable_mockModule('mongoose', () => {
  const Schema = class {
    index(): void { /* no-op */ }
  };
  const keyOf = (f: any) => `${f.source}:${f.eventId}`;
  const model = () => ({
    // Upsert that either inserts a fresh claim, re-takes an EXPIRED in_progress
    // lease, or trips a duplicate-key error (live claim / done marker present).
    findOneAndUpdate: async (filter: any, update: any) => {
      const key = keyOf(filter);
      const existing = store.get(key);
      const leaseCutoff: Date = filter.expireAt.$lte;
      const reclaimable = existing
        && existing.status === 'in_progress'
        && existing.expireAt.getTime() <= leaseCutoff.getTime();
      if (reclaimable) {
        Object.assign(existing, update.$set);
        return existing;
      }
      if (existing) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const doc = { source: filter.source, eventId: filter.eventId, status: 'in_progress', ...update.$set };
      store.set(key, doc);
      return doc;
    },
    updateOne: async (filter: any, update: any) => {
      const existing = store.get(keyOf(filter));
      if (existing) Object.assign(existing, update.$set);
      return { matchedCount: existing ? 1 : 0 };
    },
    deleteOne: async (filter: any) => {
      store.delete(keyOf(filter));
      return { deletedCount: 1 };
    },
  });
  const models = {} as Record<string, unknown>;
  return { Schema, models, model, default: { Schema, models, model } };
});

const { claimWebhookEvent, markWebhookEventDone, releaseWebhookEvent } = await import('../src/models/webhook-dedupe.js');

/** Force the in-progress lease into the past — the crash-recovery signal Mongo's
 *  TTL produces after a process dies before the done-marker is written. */
function expireLease(source: string, eventId: string): void {
  store.get(`${source}:${eventId}`).expireAt = new Date(0);
}

beforeEach(() => store.clear());

describe('claimWebhookEvent (phase 1)', () => {
  it('returns true on the first claim for a (source, eventId) pair', async () => {
    expect(await claimWebhookEvent('sns', 'evt-1')).toBe(true);
    // A short-lived in_progress claim is written (NOT yet a durable marker).
    expect(store.get('sns:evt-1')).toMatchObject({ source: 'sns', eventId: 'evt-1', status: 'in_progress' });
  });

  it('returns false for a concurrent delivery while a live claim is in progress', async () => {
    expect(await claimWebhookEvent('stripe', 'evt_1')).toBe(true);
    // Second delivery arrives before the first finished — lease still live → skip.
    expect(await claimWebhookEvent('stripe', 'evt_1')).toBe(false);
  });

  it('returns false once a durable done-marker exists (true duplicate)', async () => {
    expect(await claimWebhookEvent('stripe', 'evt_2')).toBe(true);
    await markWebhookEventDone('stripe', 'evt_2');
    expect(await claimWebhookEvent('stripe', 'evt_2')).toBe(false);
  });

  it('treats different sources with the same eventId as independent', async () => {
    expect(await claimWebhookEvent('sns', 'shared')).toBe(true);
    expect(await claimWebhookEvent('stripe', 'shared')).toBe(true);
  });

  it('rethrows non-duplicate errors so transport failures are visible', async () => {
    // A non-11000 store error (e.g. a dropped connection) must propagate, not be
    // swallowed as a duplicate.
    const spy = jest.spyOn(store, 'get').mockImplementationOnce(() => { throw new Error('connection lost'); });
    await expect(claimWebhookEvent('sns', 'evt-x')).rejects.toThrow('connection lost');
    spy.mockRestore();
  });
});

describe('markWebhookEventDone (phase 2)', () => {
  it('promotes the in_progress claim to a durable done marker', async () => {
    await claimWebhookEvent('stripe', 'evt_done');
    await markWebhookEventDone('stripe', 'evt_done');
    expect(store.get('stripe:evt_done').status).toBe('done');
    // The far-future expiry is the 30d durable TTL, not the short lease.
    expect(store.get('stripe:evt_done').expireAt.getTime()).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);
  });
});

describe('crash durability (two-phase)', () => {
  it('re-runs the event when the handler crashed before the done-marker', async () => {
    // Phase 1 claim succeeds...
    expect(await claimWebhookEvent('stripe', 'evt_crash')).toBe(true);
    // ...then the process dies before markWebhookEventDone. Its lease expires.
    expireLease('stripe', 'evt_crash');

    // The provider's retry must be allowed to REPROCESS (not dropped as a dup),
    // and then it can complete the done-marker.
    expect(await claimWebhookEvent('stripe', 'evt_crash')).toBe(true);
    await markWebhookEventDone('stripe', 'evt_crash');

    // Once done, further retries are correctly deduped.
    expect(await claimWebhookEvent('stripe', 'evt_crash')).toBe(false);
  });

  it('does NOT re-run while the lease is still live (no double-processing)', async () => {
    expect(await claimWebhookEvent('sns', 'evt_live')).toBe(true);
    // Lease not expired → a retry is skipped so two pods never both process it.
    expect(await claimWebhookEvent('sns', 'evt_live')).toBe(false);
  });
});

describe('releaseWebhookEvent (handled failure)', () => {
  it('frees the claim so the next retry reprocesses', async () => {
    expect(await claimWebhookEvent('sns', 'evt_rel')).toBe(true);
    await releaseWebhookEvent('sns', 'evt_rel');
    expect(store.has('sns:evt_rel')).toBe(false);
    expect(await claimWebhookEvent('sns', 'evt_rel')).toBe(true);
  });
});
