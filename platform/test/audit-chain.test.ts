// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

/**
 * In-memory stand-in for the AuditEvent Mongoose model. It implements just the
 * surface `audit-chain.ts` touches — `create`, `findOne(...).sort().select().lean()`
 * (tail lookup) and `find(...).sort().lean()` (chain walk) — so the append +
 * verify logic runs end-to-end against a real store without a DB.
 */
interface Row {
  _id: string;
  hash?: string;
  prevHash?: string | null;
  createdAt: Date;
  affectedOrgId?: string;
  [k: string]: unknown;
}

let store: Row[] = [];
let idSeq = 0;

function matches(doc: Row, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => (v === null ? doc[k] == null : doc[k] === v));
}

function sortDocs(arr: Row[], spec: Record<string, 1 | -1>): Row[] {
  const keys = Object.keys(spec);
  return [...arr].sort((a, b) => {
    for (const k of keys) {
      const dir = spec[k];
      let av: number | string;
      let bv: number | string;
      if (k === '_id') { av = Number(a._id); bv = Number(b._id); } else if (a[k] instanceof Date) { av = (a[k] as Date).getTime(); bv = (b[k] as Date).getTime(); } else { av = a[k] as number | string; bv = b[k] as number | string; }
      if (av < bv) return dir === 1 ? -1 : 1;
      if (av > bv) return dir === 1 ? 1 : -1;
    }
    return 0;
  });
}

const mockModel = {
  create: async (doc: Record<string, unknown>): Promise<Row> => {
    idSeq += 1;
    const row: Row = { ...(doc as Row), _id: String(idSeq) };
    store.push(row);
    return row;
  },
  findOne: (filter: Record<string, unknown>) => {
    let arr = store.filter((d) => matches(d, filter));
    const q = {
      sort: (spec: Record<string, 1 | -1>) => { arr = sortDocs(arr, spec); return q; },
      select: () => q,
      lean: async () => arr[0] ?? null,
    };
    return q;
  },
  find: (filter: Record<string, unknown>) => {
    let arr = store.filter((d) => matches(d, filter));
    const q = {
      sort: (spec: Record<string, 1 | -1>) => { arr = sortDocs(arr, spec); return q; },
      lean: async () => arr,
    };
    return q;
  },
};

jest.unstable_mockModule('../src/models/audit-event.js', () => ({
  __esModule: true,
  default: mockModel,
}));

const { appendAuditEvent, verifyAuditChain, computeAuditHash, GENESIS_CHAIN_KEY } = await import('../src/helpers/audit-chain.js');

beforeEach(() => {
  store = [];
  idSeq = 0;
});

describe('appendAuditEvent — chaining', () => {
  it('gives the first event in a chain a 64-hex hash and a null prevHash', async () => {
    const e1 = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    expect(e1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e1.prevHash).toBeNull();
  });

  it('links each new event.prevHash to the prior event.hash in the same chain', async () => {
    const e1 = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const e2 = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const e3 = await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    expect(e2.prevHash).toBe(e1.hash);
    expect(e3.prevHash).toBe(e2.hash);
    expect(e1.hash).not.toBe(e2.hash);
  });

  it('keeps a separate chain per tenant (affectedOrgId ?? orgId)', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const other = await appendAuditEvent({ action: 'user.login', actorId: 'u2', orgId: 'org-2', affectedOrgId: 'org-2' });
    // First event of org-2's chain — not linked to org-1's tail.
    expect(other.prevHash).toBeNull();
  });

  it('files a cross-tenant sysadmin action under the affectedOrgId chain', async () => {
    const own = await appendAuditEvent({ action: 'user.login', actorId: 'sa', orgId: 'system', affectedOrgId: 'system' });
    const cross = await appendAuditEvent({ action: 'admin.user.update', actorId: 'sa', orgId: 'system', affectedOrgId: 'org-9' });
    expect(cross.prevHash).toBeNull(); // starts org-9's chain, not linked to system's
    expect(own.prevHash).toBeNull();
  });

  it('serializes concurrent appends on the same chain without forking it', async () => {
    // Fire several appends at once; the per-chain lock must still produce a
    // single linear chain (each prevHash equals exactly one predecessor's hash).
    await Promise.all([
      appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-3', affectedOrgId: 'org-3' }),
      appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-3', affectedOrgId: 'org-3' }),
      appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-3', affectedOrgId: 'org-3' }),
    ]);
    const result = await verifyAuditChain('org-3');
    expect(result).toEqual({ ok: true, count: 3 });
  });
});

describe('verifyAuditChain', () => {
  it('returns ok for an intact chain', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });

    const result = await verifyAuditChain('org-1');
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it('returns ok with count 0 for an empty chain', async () => {
    expect(await verifyAuditChain('org-empty')).toEqual({ ok: true, count: 0 });
  });

  it('flags the row whose immutable field was mutated after the fact', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const tampered = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });

    // Mutate a stored, hashed field WITHOUT recomputing the hash.
    const row = store.find((r) => r._id === tampered._id)!;
    row.actorId = 'attacker';

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(tampered._id);
    expect(result.count).toBe(3);
  });

  it('detects a mutation buried in the details field', async () => {
    const e1 = await appendAuditEvent({ action: 'admin.org.tier.update', actorId: 'sa', orgId: 'org-1', affectedOrgId: 'org-1', details: { previousTier: 'pro' } });
    const row = store.find((r) => r._id === e1._id)!;
    (row.details as Record<string, unknown>).previousTier = 'enterprise';

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(e1._id);
  });

  it('flags a broken link when an event is deleted from the middle', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const middle = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const last = await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });

    // Delete the middle row: `last.prevHash` now points at a hash no walked
    // predecessor produced → broken linkage detected at `last`.
    store = store.filter((r) => r._id !== middle._id);

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(last._id);
    expect(result.count).toBe(2);
  });
});

describe('computeAuditHash — canonicalization', () => {
  const base = {
    action: 'user.login',
    actorId: 'u1',
    orgId: 'org-1',
    affectedOrgId: 'org-1',
    outcome: 'success',
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    prevHash: null,
  } as const;

  it('is deterministic for identical input', () => {
    expect(computeAuditHash({ ...base })).toBe(computeAuditHash({ ...base }));
  });

  it('is independent of details key ORDER (sorted-key canonicalization)', () => {
    const a = computeAuditHash({ ...base, details: { a: 1, b: 2 } });
    const b = computeAuditHash({ ...base, details: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('changes when any hashed field changes', () => {
    const original = computeAuditHash({ ...base });
    expect(computeAuditHash({ ...base, actorId: 'u2' })).not.toBe(original);
    expect(computeAuditHash({ ...base, prevHash: 'x'.repeat(64) })).not.toBe(original);
    expect(computeAuditHash({ ...base, createdAt: new Date('2026-07-20T00:00:00.001Z') })).not.toBe(original);
  });
});

describe('genesis (org-less) chain', () => {
  it('chains events that carry no org context together', async () => {
    const g1 = await appendAuditEvent({ action: 'user.register', actorId: 'anonymous' });
    const g2 = await appendAuditEvent({ action: 'admin.superadmin.grant', actorId: 'bootstrap-env', targetId: 'u1' });
    expect(g1.prevHash).toBeNull();
    expect(g2.prevHash).toBe(g1.hash);
    expect(await verifyAuditChain(GENESIS_CHAIN_KEY)).toEqual({ ok: true, count: 2 });
  });
});
