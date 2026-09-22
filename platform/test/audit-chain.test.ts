// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { AuditAction } from '../src/models/audit-event.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

// The chain HMAC key is an env/KMS secret (never the DB); pin one for the suite.
process.env.AUDIT_CHAIN_HMAC_KEY = 'test-audit-chain-hmac-key-0123456789abcdef';

/**
 * In-memory stand-ins for the AuditEvent + AuditChainHead Mongoose models. They
 * implement just the surface `audit-chain.ts` touches — `create`, the tail
 * repair `findOne(...).sort().select().lean()`, the verify walk
 * `find(...).sort().lean().cursor()`, and the head doc's `findById` / guarded
 * upsert `updateOne` — and enforce the two unique indexes the design leans on:
 * `(orgId, idempotencyKey)` and `(affectedOrgId, seq)`.
 */
interface Row {
  _id: string;
  hash?: string;
  prevHash?: string | null;
  seq?: number;
  createdAt: Date;
  affectedOrgId?: string;
  orgId?: string;
  [k: string]: unknown;
}

let store: Row[] = [];
let idSeq = 0;
interface HeadDoc { _id: string; seq: number; hash: string; headCreatedAt: Date }
let heads = new Map<string, HeadDoc>();
/** When set, head advances are silently dropped (a writer that died between its
 *  insert and its head update, or a failed head write). */
let dropHeadAdvances = false;

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

function dupError(keyPattern: Record<string, number>): Error & { code: number; keyPattern: Record<string, number> } {
  const err = new Error(`E11000 duplicate key error dup key: ${JSON.stringify(keyPattern)}`) as Error & { code: number; keyPattern: Record<string, number> };
  err.code = 11000;
  err.keyPattern = keyPattern;
  return err;
}

const mockModel = {
  create: async (doc: Record<string, unknown>): Promise<Row> => {
    const row0 = doc as Row;
    const key = row0.idempotencyKey as string | undefined;
    if (key && store.some((r) => r.idempotencyKey === key && (r.orgId ?? null) === (row0.orgId ?? null))) {
      throw dupError({ orgId: 1, idempotencyKey: 1 });
    }
    if (store.some((r) => (r.affectedOrgId ?? null) === (row0.affectedOrgId ?? null) && r.seq === row0.seq)) {
      throw dupError({ affectedOrgId: 1, seq: 1 });
    }
    idSeq += 1;
    const row: Row = { ...row0, _id: String(idSeq) };
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
    const leanQ = {
      cursor: () => {
        let closed = false;
        return {
          [Symbol.asyncIterator]: async function* asyncIterator() {
            for (const d of arr) {
              if (closed) return;
              yield d;
            }
          },
          close: async () => { closed = true; },
        };
      },
    };
    const q = {
      sort: (spec: Record<string, 1 | -1>) => { arr = sortDocs(arr, spec); return q; },
      lean: () => leanQ,
    };
    return q;
  },
};

const mockHeadModel = {
  findById: (id: string) => ({ select: () => ({ lean: async () => (heads.has(id) ? { ...heads.get(id)! } : null) }) }),
  updateOne: async (filter: { _id: string; seq: { $lt: number } }, update: { $set: Omit<HeadDoc, '_id'> }) => {
    if (dropHeadAdvances) return {};
    const cur = heads.get(filter._id);
    if (cur && !(cur.seq < filter.seq.$lt)) throw dupError({ _id: 1 }); // upsert insert collides on _id
    heads.set(filter._id, { _id: filter._id, ...update.$set });
    return {};
  },
};

jest.unstable_mockModule('../src/models/audit-event.js', () => ({
  __esModule: true,
  default: mockModel,
}));
jest.unstable_mockModule('../src/models/audit-chain-head.js', () => ({
  __esModule: true,
  default: mockHeadModel,
}));

const { appendAuditEvent, verifyAuditChain, computeAuditHash, GENESIS_CHAIN_KEY, PublishedHeadInvalidError } = await import('../src/helpers/audit-chain.js');

beforeEach(() => {
  store = [];
  idSeq = 0;
  heads = new Map();
  dropHeadAdvances = false;
});

/** The ok-shape of an intact chain of `n` rows starting at seq 1. */
const intact = (n: number, unverifiable = 0) => ({ ok: true, count: n, unverifiable, lastSeq: n });

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
    expect(result).toEqual(intact(3));
  });
});

describe('verifyAuditChain', () => {
  it('returns ok for an intact chain', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });

    const result = await verifyAuditChain('org-1');
    expect(result).toEqual(intact(3));
  });

  it('returns ok with count 0 for an empty chain', async () => {
    expect(await verifyAuditChain('org-empty')).toEqual(intact(0));
  });

  it('flags the row whose immutable field was mutated after the fact', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const tampered = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });

    // Mutate a stored, hashed field WITHOUT recomputing the hash.
    const row = store.find((r) => r._id === String(tampered._id))!;
    row.actorId = 'attacker';

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(tampered._id);
    // `count` is how far the walk got, inclusive of the offending row — the
    // tampered event is the 2nd of 3, and the streamed walk stops there rather
    // than reading the rest of the chain.
    expect(result.count).toBe(2);
  });

  it('detects a rewritten impersonatorId (forensic unmask field is hashed)', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const tampered = await appendAuditEvent({
      action: 'admin.user.update', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1', impersonatorId: 'sysadmin-7',
    });
    const row = store.find((r) => r._id === String(tampered._id))!;
    // Attacker tries to erase who really acted under the "view-as" token.
    row.impersonatorId = undefined;

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(tampered._id);
  });

  it('detects a rewritten roleId (which Role was touched is hashed)', async () => {
    const e1 = await appendAuditEvent({
      action: 'org.role.member.add', actorId: 'admin', orgId: 'org-1', affectedOrgId: 'org-1', roleId: 'role-viewer',
    });
    const row = store.find((r) => r._id === String(e1._id))!;
    row.roleId = 'role-admin';

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(e1._id);
  });

  it('detects a mutation buried in the details field', async () => {
    const e1 = await appendAuditEvent({ action: 'admin.org.tier.update', actorId: 'sa', orgId: 'org-1', affectedOrgId: 'org-1', details: { previousTier: 'pro' } });
    const row = store.find((r) => r._id === String(e1._id))!;
    (row.details as Record<string, unknown>).previousTier = 'enterprise';

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(e1._id);
  });

  it('flags a broken link when an event is deleted from the middle', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const middle = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });
    const last = await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-1', affectedOrgId: 'org-1' });

    // Delete the middle row: `last` now follows seq 1 directly → a sequence gap
    // detected at `last`.
    store = store.filter((r) => r._id !== String(middle._id));

    const result = await verifyAuditChain('org-1');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(last._id);
    expect(result.reason).toBe('sequence-gap');
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
    store = store.filter((r) => r._id !== String(genesis._id));
    // Sanity: the new head's prevHash is non-null (points at the pruned genesis).
    expect(store.find((r) => r._id === String(mid._id))!.prevHash).not.toBeNull();

    const result = await verifyAuditChain('org-ttl');
    expect(result).toEqual({ ok: true, count: 2, unverifiable: 0, lastSeq: 3 });
  });

  it('still flags a middle-event field tamper even when the head has aged out', async () => {
    const genesis = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-ttl2', affectedOrgId: 'org-ttl2' });
    const tampered = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-ttl2', affectedOrgId: 'org-ttl2' });
    await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-ttl2', affectedOrgId: 'org-ttl2' });

    store = store.filter((r) => r._id !== String(genesis._id)); // head aged out
    store.find((r) => r._id === String(tampered._id))!.actorId = 'attacker'; // then tamper a survivor

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
    expect((store.find((r) => r._id === String(e2._id))!.occurredAt as Date)).toEqual(occurredAt);
    // occurredAt is NOT part of the hashed field set, so recomputing the hash
    // WITHOUT it reproduces the stored hash exactly.
    const recomputed = computeAuditHash({
      action: 'pipeline.update',
      actorId: 'svc',
      orgId: 'org-oa',
      affectedOrgId: 'org-oa',
      createdAt: store.find((r) => r._id === String(e2._id))!.createdAt,
      seq: 2,
      prevHash: e1.hash ?? null,
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

    expect(await verifyAuditChain('org-oa2')).toEqual(intact(3));
  });

  it('leaves occurredAt undefined on the stored row when omitted', async () => {
    const e1 = await appendAuditEvent({ action: 'pipeline.create', actorId: 'svc', orgId: 'org-oa3', affectedOrgId: 'org-oa3' });
    expect(store.find((r) => r._id === String(e1._id))!.occurredAt).toBeUndefined();
    expect(await verifyAuditChain('org-oa3')).toEqual(intact(1));
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
    expect(await verifyAuditChain('org-1')).toEqual(intact(1));
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
    expect(await verifyAuditChain('org-2')).toEqual(intact(2));
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
    expect(await verifyAuditChain('org-9')).toEqual(intact(1));
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
    seq: 1,
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
    expect(computeAuditHash({ ...base, seq: 2 })).not.toBe(original);
  });
});

describe('genesis (org-less) chain', () => {
  it('chains events that carry no org context together', async () => {
    const g1 = await appendAuditEvent({ action: 'user.register', actorId: 'anonymous' });
    const g2 = await appendAuditEvent({ action: 'admin.superadmin.grant', actorId: 'bootstrap-env', targetId: 'u1' });
    expect(g1.prevHash).toBeNull();
    expect(g2.prevHash).toBe(g1.hash);
    expect(await verifyAuditChain(GENESIS_CHAIN_KEY)).toEqual(intact(2));
  });
});

describe('un-verifiable-hash sentinel (write-time digest failure)', () => {
  /**
   * `details` containing a BigInt makes `JSON.stringify` throw inside
   * `stableStringify`, which is the real-world shape of a digest failure: the
   * event must still be STORED (tamper-evidence is detection, never a write
   * gate) with a sentinel hash flagging it as un-verifiable.
   */
  const unhashable = (action: AuditAction) => ({
    action,
    actorId: 'u1',
    orgId: 'org-sent',
    affectedOrgId: 'org-sent',
    details: { bad: BigInt(1) } as unknown as Record<string, unknown>,
  });

  it('stores the event instead of dropping it, flagged with a sentinel hash', async () => {
    const e = await appendAuditEvent(unhashable('user.login'));
    expect(e.hash).toMatch(/^HASH_ERROR:/);
    expect(store).toHaveLength(1);
  });

  it('REGRESSION: two digest failures in one chain do not drop the next event', async () => {
    // A CONSTANT sentinel gave both rows the same `hash`, so the third append
    // read an ambiguous tail, set prevHash to the shared sentinel, and collided
    // on the unique (affectedOrgId, prevHash) index — on every retry, until it
    // exhausted MAX_CHAIN_RETRIES and threw, LOSING the audit event.
    const e1 = await appendAuditEvent(unhashable('user.login'));
    const e2 = await appendAuditEvent(unhashable('user.logout'));
    expect(e1.hash).not.toBe(e2.hash); // unique per row — the actual fix

    // The next (perfectly hashable) event still lands, linked to the tail.
    const e3 = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-sent', affectedOrgId: 'org-sent' });
    expect(e3.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e3.prevHash).toBe(e2.hash);
    expect(store).toHaveLength(3);
  });

  it('counts sentinel rows as un-verifiable rather than reporting tampering', async () => {
    await appendAuditEvent(unhashable('user.login'));
    await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-sent', affectedOrgId: 'org-sent' });

    // A sentinel row has no digest to recompute, so it must not be mistaken for
    // a mutated field — linkage across it is still enforced.
    expect(await verifyAuditChain('org-sent')).toEqual(intact(2, 1));
  });

  it('still detects tampering of a real row that follows a sentinel row', async () => {
    await appendAuditEvent(unhashable('user.login'));
    const real = await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-sent', affectedOrgId: 'org-sent' });
    store.find((r) => r._id === String(real._id))!.actorId = 'attacker';

    const result = await verifyAuditChain('org-sent');
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(real._id);
  });
});

describe('sequence ordering (no wall-clock dependence)', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('assigns contiguous per-chain seq numbers', async () => {
    const e1 = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-s', affectedOrgId: 'org-s' });
    const e2 = await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-s', affectedOrgId: 'org-s' });
    const other = await appendAuditEvent({ action: 'user.login', actorId: 'u2', orgId: 'org-t', affectedOrgId: 'org-t' });
    expect([e1.seq, e2.seq, other.seq]).toEqual([1, 2, 1]);
  });

  it('verifies a chain whose createdAt runs BACKWARDS (replica clock skew)', async () => {
    // Replica B's clock is behind replica A's: wall-clock order disagrees with
    // append order. The old createdAt-ordered walk mis-sorted these rows and
    // reported a broken chain; the seq walk doesn't care.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.setSystemTime(new Date('2026-09-21T12:00:10Z'));
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-skew', affectedOrgId: 'org-skew' });
    jest.setSystemTime(new Date('2026-09-21T12:00:00Z')); // 10s earlier
    await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-skew', affectedOrgId: 'org-skew' });
    jest.setSystemTime(new Date('2026-09-21T11:59:50Z'));
    await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-skew', affectedOrgId: 'org-skew' });

    expect(await verifyAuditChain('org-skew')).toEqual(intact(3));
  });

  it('flags a renumbered row (seq is hashed)', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-r', affectedOrgId: 'org-r' });
    const e2 = await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-r', affectedOrgId: 'org-r' });
    await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-r', affectedOrgId: 'org-r' });
    // Delete e2 and renumber the tail to close the gap.
    store = store.filter((r) => r._id !== String(e2._id));
    store.find((r) => r.seq === 3)!.seq = 2;

    const result = await verifyAuditChain('org-r', { retentionMs: 0 });
    expect(result.ok).toBe(false);
    expect(['broken-link', 'hash-mismatch']).toContain(result.reason);
  });
});

describe('cross-replica compare-and-set on (affectedOrgId, seq)', () => {
  it('a writer that loses the slot repairs a lagging head and links after the winner', async () => {
    const e1 = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-x', affectedOrgId: 'org-x' });
    // Another replica inserted seq 2 but died before advancing the head.
    dropHeadAdvances = true;
    const winner = await appendAuditEvent({ action: 'user.logout', actorId: 'u2', orgId: 'org-x', affectedOrgId: 'org-x' });
    dropHeadAdvances = false;
    expect(heads.get('org-x')!.seq).toBe(1); // head lags the stored tail

    const e3 = await appendAuditEvent({ action: 'dashboard.update', actorId: 'u1', orgId: 'org-x', affectedOrgId: 'org-x' });
    expect(winner.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(e3.prevHash).toBe(winner.hash);
    expect(e1.seq).toBe(1);
    expect(await verifyAuditChain('org-x')).toEqual(intact(3));
  });

  it('keeps counting after every event has aged out (the head has no TTL)', async () => {
    await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-old', affectedOrgId: 'org-old' });
    const last = await appendAuditEvent({ action: 'user.logout', actorId: 'u1', orgId: 'org-old', affectedOrgId: 'org-old' });
    store = []; // TTL pruned everything

    const next = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-old', affectedOrgId: 'org-old' });
    expect(next.seq).toBe(3);
    expect(next.prevHash).toBe(last.hash);
  });
});

describe('HMAC keying', () => {
  it('a DB writer without the key cannot re-chain around an edit', async () => {
    const { createHmac } = await import('crypto');
    const e1 = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-k', affectedOrgId: 'org-k' });
    const row = store.find((r) => r._id === String(e1._id))!;
    // Attacker edits a field and recomputes a digest with a key of their own.
    row.actorId = 'attacker';
    row.hash = createHmac('sha256', 'attacker-guess').update(JSON.stringify(row)).digest('hex');
    heads.set('org-k', { ...heads.get('org-k')!, hash: row.hash });

    const result = await verifyAuditChain('org-k');
    expect(result).toMatchObject({ ok: false, reason: 'hash-mismatch', brokenAt: e1._id });
  });

  it('stores a 64-hex HMAC, not the unkeyed sha256 of the canonical form', async () => {
    const { createHash } = await import('crypto');
    const e1 = await appendAuditEvent({ action: 'user.login', actorId: 'u1', orgId: 'org-k2', affectedOrgId: 'org-k2' });
    expect(e1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e1.hash).not.toBe(createHash('sha256').update(String(e1.hash)).digest('hex'));
  });
});

describe('tail truncation — in-DB head and published write-once head', () => {
  const opts = (published: { seq: number; hash: string } | null, extra: Record<string, unknown> = {}) => ({
    retentionMs: 90 * 86_400_000,
    fetchPublishedHead: async () => (published
      ? { ...published, headCreatedAt: new Date().toISOString(), exportedAt: new Date().toISOString() }
      : null),
    ...extra,
  });

  async function chainOf3(key: string) {
    const rows = [];
    for (const action of ['user.login', 'dashboard.update', 'user.logout'] as const) {
      rows.push(await appendAuditEvent({ action, actorId: 'u1', orgId: key, affectedOrgId: key }));
    }
    return rows;
  }

  it('matches when the chain reaches its published head', async () => {
    const [, , e3] = await chainOf3('org-p');
    const result = await verifyAuditChain('org-p', opts({ seq: 3, hash: e3.hash as string }));
    expect(result).toEqual({ ...intact(3), publishedHead: { status: 'matched', seq: 3, exportedAt: expect.any(String) } });
  });

  it('flags deletion of the NEWEST rows even when the attacker also rewinds the in-DB head', async () => {
    const [, e2, e3] = await chainOf3('org-p2');
    store = store.filter((r) => r._id !== String(e3._id));
    heads.set('org-p2', { _id: 'org-p2', seq: 2, hash: e2.hash as string, headCreatedAt: new Date() });

    // Without the external anchor the shorter chain is internally consistent…
    expect(await verifyAuditChain('org-p2')).toEqual(intact(2));
    // …the published head exposes it.
    const result = await verifyAuditChain('org-p2', opts({ seq: 3, hash: e3.hash as string }));
    expect(result).toMatchObject({ ok: false, reason: 'tail-truncated', lastSeq: 2 });
  });

  it('flags tail deletion against the in-DB head alone when it was not rewound', async () => {
    const [, , e3] = await chainOf3('org-p3');
    store = store.filter((r) => r._id !== String(e3._id));
    expect(await verifyAuditChain('org-p3')).toMatchObject({ ok: false, reason: 'tail-truncated' });
  });

  it('flags a published head whose hash the chain no longer has at that seq', async () => {
    await chainOf3('org-p4');
    const result = await verifyAuditChain('org-p4', opts({ seq: 3, hash: 'f'.repeat(64) }));
    expect(result).toMatchObject({ ok: false, reason: 'head-mismatch' });
  });

  it('refuses a forged / corrupt published head', async () => {
    await chainOf3('org-p5');
    const result = await verifyAuditChain('org-p5', {
      retentionMs: 90 * 86_400_000,
      fetchPublishedHead: async () => { throw new PublishedHeadInvalidError('bad sig'); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'published-head-invalid' });
  });

  it('does not flag a published head older than the retention window (its event may have aged out)', async () => {
    await chainOf3('org-p6');
    store = [];
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const result = await verifyAuditChain('org-p6', {
      retentionMs: 90 * 86_400_000,
      fetchPublishedHead: async () => ({ seq: 3, hash: 'x', headCreatedAt: old, exportedAt: old }),
      now: new Date(),
    });
    // The in-DB head is fresh here, so only neutralize it for this scenario.
    heads.clear();
    const again = await verifyAuditChain('org-p6', {
      retentionMs: 90 * 86_400_000,
      fetchPublishedHead: async () => ({ seq: 3, hash: 'x', headCreatedAt: old, exportedAt: old }),
    });
    expect(result.ok).toBe(false); // fresh in-DB head still says seq 3 existed
    expect(again).toMatchObject({ ok: true, publishedHead: { status: 'expired' } });
  });

  it('reports a stale published head (newest events not yet externally anchored)', async () => {
    const [e1] = await chainOf3('org-p7');
    const longAgo = new Date(Date.now() - 3_600_000).toISOString();
    const result = await verifyAuditChain('org-p7', {
      retentionMs: 90 * 86_400_000,
      exportIntervalMs: 300_000,
      fetchPublishedHead: async () => ({ seq: 1, hash: e1.hash as string, headCreatedAt: new Date().toISOString(), exportedAt: longAgo }),
    });
    expect(result).toMatchObject({ ok: true, publishedHead: { status: 'matched', stale: true } });
  });
});

describe('Idempotency-Key scoping', () => {
  it('scopes the key per org — another tenant cannot pre-claim (and suppress) it', async () => {
    const a = await appendAuditEvent({ action: 'pipeline.create', actorId: 'svc', orgId: 'org-a', affectedOrgId: 'org-a', idempotencyKey: 'shared' });
    const b = await appendAuditEvent({ action: 'pipeline.create', actorId: 'svc', orgId: 'org-b', affectedOrgId: 'org-b', idempotencyKey: 'shared' });
    expect(b._id).not.toBe(a._id);
    expect(store).toHaveLength(2);
  });
});
