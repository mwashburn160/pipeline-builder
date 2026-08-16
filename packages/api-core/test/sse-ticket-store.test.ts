// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from '@jest/globals';
import { createEnvSseTicketStore } from '../src/services/sse-ticket-store.js';

// No REDIS_URL / REDIS_HOST in the test env, so createEnvSseTicketStore falls
// back to the in-memory backend — which is what we exercise here.
const stores: Array<{ stop(): void }> = [];
function makeStore(cfg: { ttlMs?: number; maxTotal?: number; maxPerOrg?: number } = {}) {
  const s = createEnvSseTicketStore({ ttlMs: 30_000, maxTotal: 100, maxPerOrg: 3, ...cfg });
  stores.push(s);
  return s;
}
afterEach(() => { while (stores.length) stores.pop()!.stop(); });

describe('SSE ticket store (in-memory fallback)', () => {
  it('issues a ticket and redeems it exactly once', async () => {
    const store = makeStore();
    const issued = await store.issue('org-a');
    expect(issued.ok).toBe(true);
    const ticket = issued.ok ? issued.ticket : '';
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+$/); // base64url

    expect(await store.consume(ticket)).toEqual({ orgId: 'org-a' });
    // Single-use: a second redemption fails.
    expect(await store.consume(ticket)).toBeNull();
  });

  it('rejects an unknown ticket', async () => {
    const store = makeStore();
    expect(await store.consume('never-issued')).toBeNull();
  });

  it('enforces the per-org cap', async () => {
    const store = makeStore({ maxPerOrg: 2 });
    expect((await store.issue('org-a')).ok).toBe(true);
    expect((await store.issue('org-a')).ok).toBe(true);
    const third = await store.issue('org-a');
    expect(third).toEqual({ ok: false, reason: 'org' });
    // A different org is unaffected.
    expect((await store.issue('org-b')).ok).toBe(true);
  });

  it('frees a per-org slot once a ticket is consumed', async () => {
    const store = makeStore({ maxPerOrg: 1 });
    const first = await store.issue('org-a');
    expect(first.ok).toBe(true);
    expect((await store.issue('org-a'))).toEqual({ ok: false, reason: 'org' });
    if (first.ok) await store.consume(first.ticket);
    expect((await store.issue('org-a')).ok).toBe(true);
  });

  it('enforces the global cap', async () => {
    const store = makeStore({ maxTotal: 2, maxPerOrg: 100 });
    expect((await store.issue('org-a')).ok).toBe(true);
    expect((await store.issue('org-b')).ok).toBe(true);
    expect(await store.issue('org-c')).toEqual({ ok: false, reason: 'total' });
  });
});
