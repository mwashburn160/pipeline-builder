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

/** Mimic the Mongo E11000 duplicate-key error the unique idempotencyKey index
 *  raises when a re-delivered event carries an already-stored key. */
function makeDupKeyError(key: string): Error & { code: number; keyPattern: Record<string, number>; keyValue: Record<string, string> } {
  const err = new Error(`E11000 duplicate key error collection: audit_events index: idempotencyKey_1 dup key: { idempotencyKey: "${key}" }`) as Error & { code: number; keyPattern: Record<string, number>; keyValue: Record<string, string> };
  err.code = 11000;
  err.keyPattern = { idempotencyKey: 1 };
  err.keyValue = { idempotencyKey: key };
  return err;
}

const mockModel = {
  create: async (doc: Record<string, unknown>): Promise<Row> => {
    // Enforce the UNIQUE SPARSE idempotencyKey index: a second insert with the
    // same key throws E11000 (the correctness backstop the appender catches).
    const key = (doc as Row).idempotencyKey as string | undefined;
    if (key && store.some((r) => r.idempotencyKey === key)) {
      throw makeDupKeyError(key);
    }
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

  it('detects a rewritten impersonatorId (forensic unmask field is hashed)', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const tampered = await appendAuditEvent({
      action: 'admin.user.update', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1', impersonatorId: 'sysadmin-7',
    });
    const row = store.find((r) => r._id === tampered._id)!;
    // Attacker tries to erase who really acted under the "view-as" token.
    row.impersonatorId = undefined;

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(tampered._id);
  });

  it('detects a rewritten groupId (which Role was touched is hashed)', async () => {
    const e1 = await appendAuditEvent({
      action: 'org.role.member.add', actorId: 'admin', orgId: 'org-1', affectedOrgId: 'org-1', groupId: 'role-viewer',
    });
    const row = store.find((r) => r._id === e1._id)!;
    row.groupId = 'role-admin';

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(e1._id);
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

  it('verifies OK when the genesis head has aged out of the TTL window (first surviving prevHash != null)', async () => {
    // Build a full chain, then delete the CONTIGUOUS HEAD (the oldest row) to
    // simulate TTL retention pruning. The new first surviving event carries a
    // NON-null prevHash (it pointed at the pruned genesis). That must be accepted
    // as the chain anchor — not falsely flagged as a broken/deleted link.
    const genesis = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-ttl', affectedOrgId: 'org-ttl' });
    const mid = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-ttl', affectedOrgId: 'org-ttl' });
    await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-ttl', affectedOrgId: 'org-ttl' });

    // TTL expires the oldest row.
    store = store.filter((r) => r._id !== genesis._id);
    // Sanity: the new head's prevHash is non-null (points at the pruned genesis).
    expect(store.find((r) => r._id === mid._id)!.prevHash).not.toBeNull();

    const result = await verifyAuditChain('org-ttl');
    expect(result).toEqual({ ok: true, count: 2 });
  });

  it('still flags a middle-event field tamper even when the head has aged out', async () => {
    const genesis = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-ttl2', affectedOrgId: 'org-ttl2' });
    const tampered = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-ttl2', affectedOrgId: 'org-ttl2' });
    await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-ttl2', affectedOrgId: 'org-ttl2' });

    store = store.filter((r) => r._id !== genesis._id); // head aged out
    store.find((r) => r._id === tampered._id)!.actorId = 'attacker'; // then tamper a survivor

    const result = await verifyAuditChain('org-ttl2');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(tampered._id);
  });
});

describe('appendAuditEvent — occurredAt is display-only (outside the hash / chain ordering)', () => {
  it('persists occurredAt on the stored row without affecting the hash or prevHash', async () => {
    const occurredAt = new Date('2026-07-10T00:00:00.000Z'); // long BEFORE ingest createdAt
    const e1 = await appendAuditEvent({ action: 'pipeline.create', actorId: 'svc', orgId: 'org-oa', affectedOrgId: 'org-oa' });
    const e2 = await appendAuditEvent({ action: 'pipeline.update', actorId: 'svc', orgId: 'org-oa', affectedOrgId: 'org-oa', occurredAt });

    // The display field round-trips onto the stored doc.
    expect((store.find((r) => r._id === e2._id)!.occurredAt as Date)).toEqual(occurredAt);
    // occurredAt is NOT part of the hashed field set, so recomputing the hash
    // WITHOUT it reproduces the stored hash exactly.
    const recomputed = computeAuditHash({
      action: 'pipeline.update',
      actorId: 'svc',
      orgId: 'org-oa',
      affectedOrgId: 'org-oa',
      createdAt: store.find((r) => r._id === e2._id)!.createdAt,
      prevHash: e1.hash,
    });
    expect(recomputed).toBe(e2.hash);
  });

  it('verifies OK for a batch that includes an occurredAt-bearing event AND one whose occurredAt differs from createdAt', async () => {
    // A spool-delayed re-delivery: occurredAt (emission time) is far earlier
    // than createdAt (ingest time). It must NOT reorder or perturb the chain —
    // the chain still orders/appends by ingest createdAt.
    await appendAuditEvent({ action: 'pipeline.create', actorId: 'svc', orgId: 'org-oa2', affectedOrgId: 'org-oa2' });
    await appendAuditEvent({
      action: 'pipeline.update',
      actorId: 'svc',
      orgId: 'org-oa2',
      affectedOrgId: 'org-oa2',
      occurredAt: new Date('2020-01-01T00:00:00.000Z'), // deliberately << createdAt
    });
    await appendAuditEvent({ action: 'pipeline.delete', actorId: 'svc', orgId: 'org-oa2', affectedOrgId: 'org-oa2' });

    expect(await verifyAuditChain('org-oa2')).toEqual({ ok: true, count: 3 });
  });

  it('leaves occurredAt undefined on the stored row when omitted', async () => {
    const e1 = await appendAuditEvent({ action: 'pipeline.create', actorId: 'svc', orgId: 'org-oa3', affectedOrgId: 'org-oa3' });
    expect(store.find((r) => r._id === e1._id)!.occurredAt).toBeUndefined();
    expect(await verifyAuditChain('org-oa3')).toEqual({ ok: true, count: 1 });
  });
});

describe('appendAuditEvent — Idempotency-Key dedup', () => {
  it('produces ONE row and ONE chain link for two appends with the same key', async () => {
    const first = await appendAuditEvent({
      action: 'pipeline.create', actorId: 'svc', orgId: 'org-1', affectedOrgId: 'org-1', idempotencyKey: 'key-abc',
    });
    const second = await appendAuditEvent({
      action: 'pipeline.create', actorId: 'svc', orgId: 'org-1', affectedOrgId: 'org-1', idempotencyKey: 'key-abc',
    });

    // Deduped: the retry returns the already-stored row and does NOT write again.
    expect(store.length).toBe(1);
    expect(second._id).toBe(first._id);
    // Exactly one chain link survives (a single-event chain verifies clean).
    expect(await verifyAuditChain('org-1')).toEqual({ ok: true, count: 1 });
  });

  it('writes two rows / two chain links for different keys', async () => {
    await appendAuditEvent({
      action: 'pipeline.create', actorId: 'svc', orgId: 'org-2', affectedOrgId: 'org-2', idempotencyKey: 'key-1',
    });
    const e2 = await appendAuditEvent({
      action: 'pipeline.update', actorId: 'svc', orgId: 'org-2', affectedOrgId: 'org-2', idempotencyKey: 'key-2',
    });

    expect(store.length).toBe(2);
    // The second links to the first: a genuine second chain link.
    expect(e2.prevHash).toBe(store[0].hash);
    expect(await verifyAuditChain('org-2')).toEqual({ ok: true, count: 2 });
  });

  it('does not constrain events that carry no key (sparse)', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-3', affectedOrgId: 'org-3' });
    await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-3', affectedOrgId: 'org-3' });
    expect(store.length).toBe(2);
  });
});

describe('appendAuditEvent — AWS identifier scrub (defense-in-depth)', () => {
  it('redacts an AWS account id embedded in a KMS ARN in details before persisting + hashing', async () => {
    const stored = await appendAuditEvent({
      action: 'org.kms.orphaned',
      actorId: 'org-cascade',
      orgId: 'system',
      affectedOrgId: 'org-9',
      details: { keyId: 'arn:aws:kms:us-east-1:123456789012:key/abc-123', reason: 'manual deletion required' },
    });

    const persisted = JSON.stringify((stored.details as Record<string, unknown>));
    expect(persisted).not.toContain('123456789012');
    expect(persisted).toContain('[REDACTED]');
    expect((stored.details as { reason: string }).reason).toBe('manual deletion required');
    // Hash was computed over the SCRUBBED details, so the chain still verifies.
    expect(await verifyAuditChain('org-9')).toEqual({ ok: true, count: 1 });
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
