// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The run-request signature: EdDSA compact JWS, the protocol's header and
 * claims, the public JWK set (RFC 7638 kids), and the per-org signer: which
 * org's key signs, RUNNER_KEY_MISSING / RUNNER_KEY_UNREADABLE, cross-org
 * isolation, and the per-replica cache (pub/sub invalidation and the 60 s
 * version poll, across two replicas).
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import { applyKeyInvalidation } from '../../src/runners/deps.js';
import { ed25519Jwk, JwsVerifyError, okpThumbprint, signEdDsaJws, verifyEdDsaJws } from '../../src/runners/jws.js';
import { generateOrgKey, promoteDueKeys, publicKeysForRunner, revokeOrgKey, rotateOrgKey, setOrgKeyMode } from '../../src/runners/keys.js';
import { createOrgSignerCache, createRunRequestSigner, type ResolvedSigner } from '../../src/runners/signing.js';
import { fakeKeyStore, keyedDeps } from '../helpers/key-fakes.js';
import { claimsOf, headerOf, ORG, PARENT, runnerRow } from '../helpers/runner-fakes.js';
const NOW = Date.parse('2026-11-19T12:00:00Z');

describe('EdDSA JWS helpers', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = ed25519Jwk(privateKey);

  it('publishes an OKP JWK whose kid is the RFC 7638 thumbprint', () => {
    expect(jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: expect.any(String), kid: expect.any(String), use: 'sig', alg: 'EdDSA' });
    const expected = createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`).digest('base64url');
    expect(jwk.kid).toBe(expected);
    expect(okpThumbprint(jwk.x)).toBe(expected);
  });

  it('round-trips a signed token', () => {
    const token = signEdDsaJws({ typ: 'pb-run+jwt', kid: jwk.kid }, { a: 1 }, privateKey);
    expect(verifyEdDsaJws(token, [jwk])).toEqual({ header: { alg: 'EdDSA', typ: 'pb-run+jwt', kid: jwk.kid }, payload: { a: 1 } });
  });

  it('refuses a tampered payload, an unknown kid, a non-EdDSA alg and garbage', () => {
    const token = signEdDsaJws({ kid: jwk.kid }, { a: 1 }, privateKey);
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ a: 2 })).toString('base64url')}.${s}`;
    expect(() => verifyEdDsaJws(forged, [jwk])).toThrow('signature');
    const other = ed25519Jwk(generateKeyPairSync('ed25519').privateKey);
    expect(() => verifyEdDsaJws(token, [other])).toThrow('unknown kid');
    const hs = `${Buffer.from(JSON.stringify({ alg: 'HS256', kid: jwk.kid })).toString('base64url')}.${token.split('.')[1]}.${s}`;
    expect(() => verifyEdDsaJws(hs, [jwk])).toThrow('alg');
    expect(() => verifyEdDsaJws('a.b', [jwk])).toThrow(JwsVerifyError);
    expect(() => verifyEdDsaJws('!!.!!.!!', [jwk])).toThrow('malformed');
  });

  it('refuses a non-Ed25519 key', () => {
    expect(() => ed25519Jwk(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey)).toThrow(/Ed25519/);
  });
});

describe('createRunRequestSigner', () => {
  const current = generateKeyPairSync('ed25519').privateKey;
  const previous = generateKeyPairSync('ed25519').privateKey;

  it('signs the protocol header and claims (exp = iat + 600, aud = runner, jti = request)', () => {
    const signer = createRunRequestSigner(current, undefined, () => NOW);
    const jws = signer.sign({
      runnerId: 'r-1',
      requestId: 'q-1',
      action: 'start',
      pipelineId: 'p-1',
      hint: { region: 'us-east-1', pipelineName: 'acme' },
      requestedBy: 'u-1',
    });
    expect(headerOf(jws)).toEqual({ alg: 'EdDSA', typ: 'pb-run+jwt', kid: ed25519Jwk(current).kid });
    const iat = Math.floor(NOW / 1000);
    expect(claimsOf(jws)).toEqual({
      iss: 'pipeline-builder',
      aud: 'r-1',
      jti: 'q-1',
      iat,
      exp: iat + 600,
      action: 'start',
      pipelineId: 'p-1',
      hint: { region: 'us-east-1', pipelineName: 'acme' },
      requestedBy: 'u-1',
    });
    expect(verifyEdDsaJws(jws, signer.jwks().keys).payload.aud).toBe('r-1');
  });

  it('never outlives the request, and a ping carries no pipelineId', () => {
    const signer = createRunRequestSigner(current, undefined, () => NOW);
    const jws = signer.sign({ runnerId: 'r', requestId: 'q', action: 'ping', requestedBy: 'system:runner-ping', expiresAt: new Date(NOW + 30_000) });
    const c = claimsOf(jws);
    expect(c.exp).toBe(Math.floor(NOW / 1000) + 30);
    expect(c).not.toHaveProperty('pipelineId');
    expect(c).not.toHaveProperty('hint');
    const stop = claimsOf(signer.sign({ runnerId: 'r', requestId: 'q', action: 'stop', pipelineId: 'p', executionId: 'e-1', requestedBy: 'u' }));
    expect(stop.executionId).toBe('e-1');
  });

  it('publishes both keys during a rotation (current first); a token from the previous key still verifies', () => {
    const before = createRunRequestSigner(previous, undefined, () => NOW);
    const old = before.sign({ runnerId: 'r', requestId: 'q', action: 'ping', requestedBy: 'u' });
    const after = createRunRequestSigner(current, previous, () => NOW);
    const { keys } = after.jwks();
    expect(keys.map((k) => k.kid)).toEqual([ed25519Jwk(current).kid, ed25519Jwk(previous).kid]);
    expect(() => verifyEdDsaJws(old, keys)).not.toThrow();
    expect(headerOf(after.sign({ runnerId: 'r', requestId: 'q', action: 'ping', requestedBy: 'u' })).kid).toBe(keys[0]!.kid);
    // The same key twice publishes once.
    expect(createRunRequestSigner(current, current).jwks().keys).toHaveLength(1);
    // Published keys are public halves only.
    expect(JSON.stringify(keys)).not.toMatch(/"d"/);
  });
});


const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const TEAM = ORG;
const ROOT = PARENT;
const ping = (runnerId: string) => ({ runnerId, requestId: 'q', action: 'ping' as const, requestedBy: 'u' });
const kidOf = (jws: string) => headerOf(jws).kid as string;
const user = { userId: 'admin-1' };

describe('createOrgSignerCache', () => {
  const resolved = (kid: string, version: number): ResolvedSigner => ({
    signer: { kid, jwks: () => ({ keys: [] }), sign: () => kid },
    versionOrgIds: ['o'],
    version,
  });

  it('serves a hit for the TTL without a version read, then keeps it while the version is unchanged', async () => {
    let t = 0;
    const resolve = jest.fn(async () => resolved('k1', 7));
    const version = jest.fn(async () => 7);
    const cache = createOrgSignerCache({ resolve, version, now: () => t, ttlMs: 60_000 });
    expect((await cache.signerFor('O')).kid).toBe('k1');
    t = 59_000;
    await cache.signerFor('o');
    expect(version).not.toHaveBeenCalled();
    t = 61_000;
    await cache.signerFor('o');
    expect(version).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('a version bump seen by the poll rebuilds the entry (counted source=poll); an invalidation drops it at once (source=pubsub)', async () => {
    let t = 0;
    let v = 1;
    const sources: string[] = [];
    const resolve = jest.fn(async () => resolved(`k${v}`, v));
    const cache = createOrgSignerCache({ resolve, version: async () => v, now: () => t, onInvalidate: (s) => sources.push(s) });
    expect((await cache.signerFor('o')).kid).toBe('k1');
    v = 2;
    t += 60_000;
    expect((await cache.signerFor('o')).kid).toBe('k2');
    v = 3;
    cache.invalidate(['O']);
    expect((await cache.signerFor('o')).kid).toBe('k3');
    expect(sources).toEqual(['poll', 'pubsub']);
    cache.invalidate(['never-cached']);
    expect(sources).toHaveLength(2);
  });

  it('concurrent first calls share one resolution; a resolution racing an invalidation is not cached; failures are not cached', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const resolve = jest.fn(async () => { n++; await gate; return resolved(`k${n}`, n); });
    const cache = createOrgSignerCache({ resolve, version: async () => 0 });
    const a = cache.signerFor('o');
    const b = cache.signerFor('o');
    cache.invalidate(['o']);
    release();
    expect((await a).kid).toBe((await b).kid);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);
    const failing = createOrgSignerCache({ resolve: jest.fn(async () => { throw new Error('nope'); }), version: async () => 0 });
    await expect(failing.signerFor('o')).rejects.toThrow('nope');
    expect(failing.size()).toBe(0);
  });

  it('a call made AFTER an invalidation never joins a resolution that started before it (the revoked key is not served)', async () => {
    const releases: Array<() => void> = [];
    let n = 0;
    const resolve = jest.fn(async () => {
      const mine = ++n;
      await new Promise<void>((r) => { releases.push(r); });
      return resolved(`k${mine}`, mine);
    });
    const cache = createOrgSignerCache({ resolve, version: async () => 0 });
    const before = cache.signerFor('o');
    cache.invalidate(['o']);
    const after = cache.signerFor('o');
    expect(resolve).toHaveBeenCalledTimes(2);
    releases.forEach((r) => r());
    expect((await before).kid).toBe('k1');
    expect((await after).kid).toBe('k2');
    // The fresh resolution is cached; the stale one's cleanup did not drop it.
    expect(cache.size()).toBe(1);
    expect((await cache.signerFor('o')).kid).toBe('k2');
    expect(resolve).toHaveBeenCalledTimes(2);
    // clear() (a resubscribe) is an invalidation too.
    const r2 = jest.fn(async () => resolved('x', 1));
    const c2 = createOrgSignerCache({ resolve: r2, version: async () => 0 });
    const p1 = c2.signerFor('o');
    c2.clear();
    const p2 = c2.signerFor('o');
    await Promise.all([p1, p2]);
    expect(r2).toHaveBeenCalledTimes(2);
  });
});

describe('signerFor: the owning org\'s effective key', () => {
  it('a root org signs with its own active key; a team in inherit mode (the default) with its parent\'s', async () => {
    const deps = keyedDeps();
    deps.parents.set(TEAM, ROOT);
    const { kid } = await generateOrgKey(deps, ROOT, user);
    expect((await deps.signerFor(ROOT)).kid).toBe(kid);
    expect((await deps.signerFor(TEAM)).kid).toBe(kid);
  });

  it('a team with its own key signs with it; a parent runner shared with the team still uses the parent\'s key', async () => {
    const deps = keyedDeps();
    deps.parents.set(TEAM, ROOT);
    const root = await generateOrgKey(deps, ROOT, user);
    await setOrgKeyMode(deps, TEAM, 'own', user);
    deps.clock.t += 11 * 60_000;
    await promoteDueKeys(deps);
    const team = (await deps.keyStore.publishedKeys([TEAM]))[0]!;
    expect(team.state).toBe('active');
    deps.keyCaches.signers.clear();
    expect((await deps.signerFor(TEAM)).kid).toBe(team.kid);
    // The runner row's org decides: the parent's shared runner signs with the parent's key.
    const shared = runnerRow({ orgId: ROOT, shareWithTeams: true });
    deps.store.runners.set(shared.id, shared);
    expect((await deps.signerFor(shared.orgId)).kid).toBe(root.kid);
  });

  it('no effective key: RUNNER_KEY_MISSING (no shared key to fall back to)', async () => {
    const deps = keyedDeps();
    await expect(deps.signerFor(ROOT)).rejects.toMatchObject({ code: 'RUNNER_KEY_MISSING', status: 409 });
    deps.parents.set(TEAM, ROOT);
    await expect(deps.signerFor(TEAM)).rejects.toMatchObject({ code: 'RUNNER_KEY_MISSING' });
  });

  it('an unreadable key fails closed for that org only, raises the alert gauge once and tells the operator once', async () => {
    const deps = keyedDeps();
    await generateOrgKey(deps, ROOT, user);
    const other = await generateOrgKey(deps, OTHER, user);
    deps.notified.length = 0;
    deps.secrets.unreadable.add(ROOT);
    await expect(deps.signerFor(ROOT)).rejects.toMatchObject({ code: 'RUNNER_KEY_UNREADABLE', status: 409 });
    await expect(deps.signerFor(ROOT)).rejects.toMatchObject({ code: 'RUNNER_KEY_UNREADABLE' });
    expect((await deps.signerFor(OTHER)).kid).toBe(other.kid);
    expect(deps.gaugeValues.get('pipeline_runner_signing_keys_unreadable')).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(deps.notified).toHaveLength(1);
    expect(deps.notified[0]).toMatchObject({ recipientOrgId: '000000000000000000000001', subject: 'Runner signing key unreadable' });
    // Fixed: the next decrypt clears it.
    deps.secrets.unreadable.clear();
    await deps.signerFor(ROOT);
    expect(deps.gaugeValues.get('pipeline_runner_signing_keys_unreadable')).toBe(0);
  });

  it('cross-org: org B\'s runner rejects a request signed with org A\'s key', async () => {
    const deps = keyedDeps();
    await generateOrgKey(deps, ROOT, user);
    await generateOrgKey(deps, OTHER, user);
    const runnerB = runnerRow({ orgId: OTHER, id: '11111111-1111-4111-8111-111111111111' });
    deps.store.runners.set(runnerB.id, runnerB);
    const jwksB = (await publicKeysForRunner(deps, runnerB.id))!.keys;
    const fromA = (await deps.signerFor(ROOT)).sign(ping(runnerB.id));
    expect(() => verifyEdDsaJws(fromA, jwksB)).toThrow(JwsVerifyError);
    // Its own org's key verifies.
    expect(verifyEdDsaJws((await deps.signerFor(OTHER)).sign(ping(runnerB.id)), jwksB).payload.aud).toBe(runnerB.id);
  });

  it('the cache refreshes on a version bump: after a promotion the new key signs within the 60 s poll', async () => {
    const deps = keyedDeps();
    const first = await generateOrgKey(deps, ROOT, user);
    expect((await deps.signerFor(ROOT)).kid).toBe(first.kid);
    const next = await rotateOrgKey(deps, ROOT, user);
    deps.clock.t += 11 * 60_000;
    await promoteDueKeys(deps);
    // No pub/sub delivered here (publishKeyInvalidation is a recorder): the poll catches it.
    expect(deps.counterAdds.filter(([n]) => n === 'pipeline_runner_signing_key_invalidations_total')).toHaveLength(0);
    expect(kidOf((await deps.signerFor(ROOT)).sign(ping('r')))).toBe(next.kid);
    expect(deps.counterAdds).toContainEqual(['pipeline_runner_signing_key_invalidations_total', { source: 'poll' }, 1]);
  });
});

describe('invalidation across two replicas (two signer caches over one store)', () => {
  function replicas() {
    const store = fakeKeyStore();
    const a = keyedDeps({}, { keyStore: store });
    const b = keyedDeps({}, { keyStore: store });
    b.clock = a.clock;
    b.now = a.now;
    // The bus: every publish reaches both replicas (the sender's own echo included).
    const deliver = (m: Record<string, unknown>) => { for (const d of [a, b]) applyKeyInvalidation(d, { v: 1, origin: 'a', ...m } as never); };
    return { a, b, deliver };
  }

  it('a revoke on one replica stops signing with the old key on the other at once (pub/sub)', async () => {
    const { a, b, deliver } = replicas();
    a.publishKeyInvalidation = (m) => deliver(m as Record<string, unknown>);
    const first = await generateOrgKey(a, ROOT, user);
    expect((await b.signerFor(ROOT)).kid).toBe(first.kid);
    const out = await revokeOrgKey(a, ROOT, user, first.kid.slice(-6));
    // Same clock instant on b: only the message can have dropped its entry.
    expect((await b.signerFor(ROOT)).kid).toBe(out.activeKid);
    expect(b.counterAdds).toContainEqual(['pipeline_runner_signing_key_invalidations_total', { source: 'pubsub' }, 1]);
  });

  it('a dropped message is caught by the 60 s version poll', async () => {
    const { a, b } = replicas();
    const first = await generateOrgKey(a, ROOT, user);
    expect((await b.signerFor(ROOT)).kid).toBe(first.kid);
    const out = await revokeOrgKey(a, ROOT, user, first.kid.slice(-6)); // message lost
    expect((await b.signerFor(ROOT)).kid).toBe(first.kid);
    a.clock.t += 60_000;
    expect((await b.signerFor(ROOT)).kid).toBe(out.activeKid);
  });

  it('a pause message makes the next pause read hit the store', async () => {
    const { a, b } = replicas();
    expect(await b.deliveriesPaused()).toBe(false);
    await a.keyStore.setPause({ paused: true, by: 'op', reason: null, at: new Date(a.now()) });
    expect(await b.deliveriesPaused()).toBe(false); // cached
    applyKeyInvalidation(b, { v: 1, kind: 'pause', origin: 'a', paused: true });
    expect(await b.deliveriesPaused()).toBe(true);
  });
});
