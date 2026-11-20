// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The key store and key lifecycle against a REAL Postgres (PGlite + the shipped
 * init script, as the app role under RLS) with REAL secret encryption: the
 * partial unique indexes (a concurrent rotate gets 409), promotion order, the
 * version counter, the pause row, re-encryption after a master-key rotation,
 * and an unreadable key failing closed for its org only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { resetDefaultKeyProvider } from '@pipeline-builder/api-core';
import { bootTenantDb, type TenantTestDb } from '@pipeline-builder/pipeline-data/testing';

process.env.JWT_SECRET ||= 'runner-keys-pglite-test-secret';
const MASTER_A = 'a'.repeat(64);
const MASTER_B = 'b'.repeat(64);
process.env.SECRET_ENCRYPTION_KEY = MASTER_A;
delete process.env.SECRET_ENCRYPTION_KEY_PREVIOUS;

const { createDrizzleKeyStore } = await import('../../src/runners/key-store.js');
const { keySecrets } = await import('../../src/runners/key-crypto.js');
const { reencryptRunnerKeys } = await import('../../src/runners/key-reencrypt.js');
const { generateOrgKey, promoteDueKeys, revokeOrgKey, rotateOrgKey, setOrgKeyMode } = await import('../../src/runners/keys.js');
const { keyedDeps } = await import('../helpers/key-fakes.js');
const { ORG, PARENT } = await import('../helpers/runner-fakes.js');

const A = PARENT;
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const user = { userId: 'admin-1' };

let tdb: TenantTestDb;
const store = createDrizzleKeyStore();

function deps() {
  const d = keyedDeps({}, { keyStore: store as never });
  d.secrets = keySecrets() as never;
  return d;
}
const useMaster = (current: string, previous?: string) => {
  process.env.SECRET_ENCRYPTION_KEY = current;
  if (previous) process.env.SECRET_ENCRYPTION_KEY_PREVIOUS = previous; else delete process.env.SECRET_ENCRYPTION_KEY_PREVIOUS;
  resetDefaultKeyProvider();
};
const rows = (org: string) => tdb.asOwner(async (q) => (await q.query<{ state: string; kid: string; private_key_enc: string | null; runner_key_version: string }>(
  'SELECT state, kid, private_key_enc, runner_key_version FROM pipeline_runner_signing_keys WHERE org_id = $1 ORDER BY created_at, state', [org])).rows);

beforeAll(async () => { tdb = await bootTenantDb(); }, 120_000);
afterAll(async () => { await tdb?.close(); useMaster(MASTER_A); });
beforeEach(async () => {
  useMaster(MASTER_A);
  await tdb.asOwner((q) => q.exec('DELETE FROM pipeline_runner_signing_keys; DELETE FROM pipeline_runner_key_settings; DELETE FROM pipeline_runner_platform_settings;'));
});

describe('Drizzle key store (real SQL, app role)', () => {
  it('the tables are present; generate stores only the encrypted PEM; the version rises on every change', async () => {
    expect(await store.tablesPresent()).toBe(true);
    const d = deps();
    const { kid } = await generateOrgKey(d, A, user);
    const [row] = await rows(A);
    expect(row).toMatchObject({ state: 'active', kid });
    expect(row!.private_key_enc).not.toMatch(/PRIVATE KEY/);
    expect(JSON.parse(row!.private_key_enc!)).toMatchObject({ alg: 'aes-256-gcm-v1' });
    const v1 = await store.version([A]);
    expect(v1).toBeGreaterThan(0);
    await rotateOrgKey(d, A, user);
    const v2 = await store.version([A]);
    expect(v2).toBeGreaterThan(v1);
    expect(await store.version([B])).toBe(0);
    expect((await d.signerFor(A)).kid).toBe(kid);
  });

  it('concurrent rotates: the partial unique index lets one win; the other is 409 RUNNER_KEY_TRANSITION_IN_PROGRESS', async () => {
    const d = deps();
    await generateOrgKey(d, A, user);
    const results = await Promise.allSettled([rotateOrgKey(d, A, user), rotateOrgKey(d, A, user), rotateOrgKey(d, A, user)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
      expect(r.reason).toMatchObject({ code: 'RUNNER_KEY_TRANSITION_IN_PROGRESS', status: 409 });
    }
    expect((await rows(A)).map((r) => r.state).sort()).toEqual(['active', 'next']);
  });

  it('a raw second active key is refused by the index (23505), so promotion moves active out first', async () => {
    const d = deps();
    await generateOrgKey(d, A, user);
    await rotateOrgKey(d, A, user);
    d.clock.t += 11 * 60_000;
    await promoteDueKeys(d);
    expect((await rows(A)).map((r) => r.state).sort()).toEqual(['active', 'retiring']);
    // A second rotation, promoted while the first retiring key is still there, retires it first.
    d.clock.t += 61 * 60_000;
    await expect(rotateOrgKey(d, A, user)).rejects.toMatchObject({ code: 'RUNNER_KEY_TRANSITION_IN_PROGRESS' });
    const dup = await store.transaction(async (tx) => tx.insertKey({
      orgId: A,
      kid: 'dup-kid',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x', kid: 'dup-kid', use: 'sig', alg: 'EdDSA' },
      privateKeyEnc: '{}',
      state: 'active',
      activatesAt: new Date(),
    })).then(() => null, (e: { code?: string; cause?: { code?: string } }) => e.code ?? e.cause?.code);
    expect(dup).toBe('23505');
  });

  it('revoke and a mode switch run in one transaction each; retired rows have the private key wiped', async () => {
    const d = deps();
    d.parents.set(ORG, A);
    const first = await generateOrgKey(d, A, user);
    await revokeOrgKey(d, A, user, first.kid.slice(-6));
    const r = await rows(A);
    expect(r.find((x) => x.kid === first.kid)).toMatchObject({ state: 'retired', private_key_enc: null });
    await setOrgKeyMode(d, ORG, 'own', user);
    expect((await rows(ORG)).map((x) => x.state)).toEqual(['next']);
    const [s] = await store.settings([ORG]);
    expect(s).toMatchObject({ mode: 'own', transitionKind: 'to_own', previousKeyOrgId: A });
  });

  it('the pause toggle: missing row = not paused; upserted on set', async () => {
    expect(await store.getPause()).toBeNull();
    const at = new Date('2026-11-19T12:00:00Z');
    expect(await store.setPause({ paused: true, by: 'op-1', reason: 'incident', at })).toMatchObject({ deliveriesPaused: true, pausedBy: 'op-1', pauseReason: 'incident' });
    expect(await store.setPause({ paused: false, by: 'op-1', reason: null, at })).toMatchObject({ deliveriesPaused: false, pausedBy: null, pausedAt: null });
  });
});

describe('re-encryption and unreadable keys (real secret encryption)', () => {
  it('after a master rotation the job re-wraps every key, and they still decrypt once the previous master is gone', async () => {
    const d = deps();
    const a = await generateOrgKey(d, A, user);
    const b = await generateOrgKey(d, B, user);
    const before = (await rows(A))[0]!.private_key_enc;
    useMaster(MASTER_B, MASTER_A);
    const result = await reencryptRunnerKeys(d);
    expect(result).toEqual({ scanned: 2, reencrypted: 2, failures: [] });
    expect((await rows(A))[0]!.private_key_enc).not.toBe(before);
    expect(d.published).toEqual(expect.arrayContaining([{ kind: 'keys', orgIds: [A] }, { kind: 'keys', orgIds: [B] }]));
    expect(d.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.reencrypt', targetId: '*', details: { scanned: 2, reencrypted: 2, failed: 0 } }));
    useMaster(MASTER_B);
    const fresh = deps();
    expect((await fresh.signerFor(A)).kid).toBe(a.kid);
    expect((await fresh.signerFor(B)).kid).toBe(b.kid);
  });

  it('without re-encryption the old rows are unreadable: RUNNER_KEY_UNREADABLE for that org only; the job reports and leaves the row', async () => {
    const d = deps();
    await generateOrgKey(d, A, user);
    // Org B's key is written under the NEW master; org A's under the old one.
    useMaster(MASTER_B);
    const b = await generateOrgKey(d, B, user);
    const fresh = deps();
    await expect(fresh.signerFor(A)).rejects.toMatchObject({ code: 'RUNNER_KEY_UNREADABLE' });
    expect((await fresh.signerFor(B)).kid).toBe(b.kid);
    expect(fresh.keyCaches.unreadable.has(A)).toBe(true);
    const before = (await rows(A))[0]!.private_key_enc;
    const result = await reencryptRunnerKeys(fresh);
    expect(result.scanned).toBe(2);
    expect(result.reencrypted).toBe(1);
    expect(result.failures).toEqual([{ orgId: A, kid: expect.any(String), error: 'decrypt failed' }]);
    expect((await rows(A))[0]!.private_key_enc).toBe(before);
    expect(JSON.stringify(result)).not.toContain(before!);
  });

  it('one org only (`orgId`): reads with the shared provider when there was no previous per-org config', async () => {
    const d = deps();
    await generateOrgKey(d, A, user);
    await generateOrgKey(d, B, user);
    const result = await reencryptRunnerKeys(d, { orgId: A, previousKmsConfig: null });
    expect(result).toEqual({ scanned: 1, reencrypted: 1, failures: [] });
    expect(d.audits).toContainEqual(expect.objectContaining({ action: 'pipeline.runner.key.reencrypt', targetId: A, affectedOrgId: A }));
  });
});
