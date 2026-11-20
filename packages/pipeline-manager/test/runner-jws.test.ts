// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner's signed-request verification: every way a request can be not
 * validly signed for THIS runner is refused, and the key-set cache refetches
 * only when it should.
 */

import { describe, it, expect } from '@jest/globals';
import { runnerJwksPath } from '@pipeline-builder/api-core/pipeline-runners';
import { claims, clock, fakeFetch, makeKey, NOW_MS, NOW_S, signJws } from './helpers/runner-fixtures.js';

const { JwksCache, ReplayCache, SignatureError, JwksUnavailableError, verifyRunRequest } = await import('../src/lambda/runner-jws.js');

const key = makeKey('k1');
const other = makeKey('k2');
/** The runner's own key set (its owning org's keys only). */
const JWKS_PATH = runnerJwksPath('runner-1');
const JWKS_URL = `https://platform.example${JWKS_PATH}`;

function setup(keys = [key.jwk]) {
  const c = clock();
  const f = fakeFetch({ [JWKS_PATH]: () => ({ status: 200, body: { keys } }) });
  const jwks = new JwksCache(JWKS_URL, f.fn, c.now);
  const verify = (jws: string, ...rid: [string | undefined] | []) => verifyRunRequest(jws, { jwks, runnerId: rid.length ? rid[0] : 'runner-1', now: c.now });
  return { c, f, jwks, verify };
}

async function rejects(p: Promise<unknown>, reason: RegExp) {
  await expect(p).rejects.toBeInstanceOf(SignatureError);
  await expect(p).rejects.toThrow(reason);
}

describe('verifyRunRequest', () => {
  it('accepts a valid request and returns its claims', async () => {
    const { verify } = setup();
    const c = await verify(signJws(key, claims({ hint: { region: 'us-east-1', pipelineName: 'acme-app-pipeline' } })));
    expect(c).toMatchObject({ jti: 'req-1', action: 'start', pipelineId: 'pipe-1', hint: { region: 'us-east-1', pipelineName: 'acme-app-pipeline' } });
  });

  it('refuses a bad signature (signed by a different key under the trusted kid)', async () => {
    const { verify } = setup();
    await rejects(verify(signJws({ ...other, kid: 'k1' }, claims())), /bad signature/);
  });

  it('refuses a tampered payload', async () => {
    const { verify } = setup();
    const [h, , s] = signJws(key, claims()).split('.');
    const p = Buffer.from(JSON.stringify(claims({ pipelineId: 'pipe-2' }))).toString('base64url');
    await rejects(verify(`${h}.${p}.${s}`), /bad signature/);
  });

  it.each([
    ['wrong typ', { typ: 'JWT' }, /wrong typ/],
    ['wrong alg', { alg: 'RS256' }, /wrong alg/],
    ['alg none', { alg: 'none' }, /wrong alg/],
    ['missing kid', { kid: undefined }, /missing kid/],
  ])('refuses %s', async (_n, header, reason) => {
    const { verify } = setup();
    await rejects(verify(signJws(key, claims(), header)), reason);
  });

  it('refuses the wrong issuer', async () => {
    const { verify } = setup();
    await rejects(verify(signJws(key, claims({ iss: 'someone-else' }))), /wrong iss/);
  });

  it('refuses a request addressed to another runner', async () => {
    const { verify } = setup();
    await rejects(verify(signJws(key, claims({ aud: 'runner-2' }))), /wrong aud/);
  });

  it('refuses an expired request, beyond the 120 s skew', async () => {
    const { verify } = setup();
    await rejects(verify(signJws(key, claims({ iat: NOW_S - 800, exp: NOW_S - 121 }))), /expired/);
  });

  it('tolerates expiry within the 120 s skew', async () => {
    const { verify } = setup();
    await expect(verify(signJws(key, claims({ iat: NOW_S - 700, exp: NOW_S - 100 })))).resolves.toBeDefined();
  });

  it('refuses a request issued more than 120 s in the future, tolerates less', async () => {
    const { verify } = setup();
    await rejects(verify(signJws(key, claims({ iat: NOW_S + 121, exp: NOW_S + 721 }))), /future/);
    await expect(verify(signJws(key, claims({ iat: NOW_S + 119, exp: NOW_S + 719 })))).resolves.toBeDefined();
  });

  it('refuses a lifetime longer than 600 s', async () => {
    const { verify } = setup();
    await rejects(verify(signJws(key, claims({ exp: NOW_S + 601 }))), /lifetime/);
  });

  it('refuses malformed input', async () => {
    const { verify } = setup();
    await rejects(verify('not-a-jws'), /compact JWS/);
    await rejects(verify('a.b'), /compact JWS/);
  });

  it('requires pipelineId (non-ping) and executionId (stop, status)', async () => {
    const { verify } = setup();
    await rejects(verify(signJws(key, claims({ pipelineId: undefined }))), /pipelineId/);
    await rejects(verify(signJws(key, claims({ action: 'stop' }))), /executionId/);
    await rejects(verify(signJws(key, claims({ action: 'status' }))), /executionId/);
    await expect(verify(signJws(key, claims({ action: 'status', executionId: 'e-1' })))).resolves.toMatchObject({ action: 'status', executionId: 'e-1' });
    await rejects(verify(signJws(key, claims({ action: 'deploy' }))), /unknown action/);
  });

  it('a runner without RUNNER_ID refuses everything — a ping included, whatever its aud', async () => {
    const { verify } = setup();
    for (const aud of ['whatever', 'runner-1', '']) {
      await rejects(verify(signJws(key, claims({ action: 'ping', pipelineId: undefined, aud })), undefined), /RUNNER_ID|missing aud/);
    }
    await rejects(verify(signJws(key, claims()), undefined), /RUNNER_ID/);
    await rejects(verify(signJws(key, claims()), ''), /RUNNER_ID/);
  });

  it('a ping for another runner is refused like any other request', async () => {
    const { verify } = setup();
    await rejects(verify(signJws(key, claims({ action: 'ping', pipelineId: undefined, aud: 'runner-2' }))), /wrong aud/);
  });
});

describe('JwksCache', () => {
  it('refuses an unknown kid without refetching within a minute, then refetches after', async () => {
    const keys = [key.jwk];
    const { c, f, verify } = setup(keys);
    await verify(signJws(key, claims()));
    expect(f.calls).toHaveLength(1);

    keys.push(other.jwk); // the platform rotates in a new key
    c.advance(30_000);
    await rejects(verify(signJws(other, claims({ jti: 'r2' }))), /unknown kid/);
    expect(f.calls).toHaveLength(1);

    c.advance(31_000);
    await expect(verify(signJws(other, claims({ jti: 'r3', iat: NOW_S + 61, exp: NOW_S + 661 })))).resolves.toBeDefined();
    expect(f.calls).toHaveLength(2);
  });

  it('caches for 10 minutes', async () => {
    const { c, f, jwks } = setup();
    await jwks.get('k1');
    c.advance(9 * 60_000);
    await jwks.get('k1');
    expect(f.calls).toHaveLength(1);
    c.advance(60_000);
    await jwks.get('k1');
    expect(f.calls).toHaveLength(2);
  });

  it('ignores keys that are not Ed25519 signing keys', async () => {
    const { jwks } = setup([{ ...key.jwk, use: 'enc' }, { ...other.jwk, crv: 'X25519' }]);
    expect(await jwks.get('k1')).toBeUndefined();
    expect(await jwks.get('k2')).toBeUndefined();
  });

  it('is unavailable (not a signature failure) when the key set cannot be fetched and none is cached', async () => {
    const c = clock();
    const f = fakeFetch({ 'jwks.json': () => ({ status: 503, body: {} }) });
    const jwks = new JwksCache(`https://p${JWKS_PATH}`, f.fn, c.now);
    await expect(jwks.get('k1')).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('fetches the key set from the configured URL only, refusing redirects', async () => {
    const { f, jwks } = setup();
    await jwks.get('k1');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(JWKS_URL);
    expect(JWKS_URL).toBe('https://platform.example/api/pipelines/runner/runners/runner-1/jwks.json');
    expect(f.calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('a failed refresh with keys cached is retried at most once a minute, not on every request', async () => {
    const c = clock();
    let up = true;
    const f = fakeFetch({ 'jwks.json': () => (up ? { status: 200, body: { keys: [key.jwk] } } : { status: 500, body: {} }) });
    const jwks = new JwksCache(`https://p${JWKS_PATH}`, f.fn, c.now);
    await jwks.get('k1');
    up = false;
    c.advance(11 * 60_000);
    for (let i = 0; i < 5; i += 1) expect(await jwks.get('k1')).toBeDefined();
    expect(f.calls).toHaveLength(2);
    c.advance(61_000);
    up = true;
    await jwks.get('k1');
    expect(f.calls).toHaveLength(3);
  });

  it('with nothing cached, every request retries the fetch (a 500, never a 401 from a throttled empty cache)', async () => {
    const c = clock();
    const f = fakeFetch({ 'jwks.json': () => ({ status: 503, body: {} }) });
    const jwks = new JwksCache(`https://p${JWKS_PATH}`, f.fn, c.now);
    await expect(jwks.get('k1')).rejects.toBeInstanceOf(JwksUnavailableError);
    c.advance(1_000);
    await expect(jwks.get('k1')).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  it('a 404 (unknown or revoked runner, or an owner with no keys) means NO keys: it fails closed, never a 500', async () => {
    const c = clock();
    const f = fakeFetch({ 'jwks.json': () => ({ status: 404, body: { error: 'not found' } }) });
    const jwks = new JwksCache(`https://p${JWKS_PATH}`, f.fn, c.now);
    const verify = (jws: string) => verifyRunRequest(jws, { jwks, runnerId: 'runner-1', now: c.now });
    await rejects(verify(signJws(key, claims())), /unknown kid/);
    // Not retried on every request: an unknown kid refetches at most once a minute.
    await rejects(verify(signJws(key, claims({ jti: 'r2' }))), /unknown kid/);
    expect(f.calls).toHaveLength(1);
  });

  it('a 404 drops keys already cached: a revoked runner stops accepting its old key', async () => {
    const c = clock();
    let revoked = false;
    const f = fakeFetch({ 'jwks.json': () => (revoked ? { status: 404, body: {} } : { status: 200, body: { keys: [key.jwk] } }) });
    const jwks = new JwksCache(`https://p${JWKS_PATH}`, f.fn, c.now);
    expect(await jwks.get('k1')).toBeDefined();
    revoked = true;
    c.advance(10 * 60_000);
    expect(await jwks.get('k1')).toBeUndefined();
    expect(f.calls).toHaveLength(2);
  });

  it('a key rotated in mid-cache (unknown kid) is fetched at once; a second unknown kid within the minute is not', async () => {
    const keys = [key.jwk];
    const { c, f, verify } = setup(keys);
    await verify(signJws(key, claims()));
    c.advance(2 * 60_000);
    keys.push(other.jwk);
    await expect(verify(signJws(other, claims({ jti: 'r2', iat: NOW_S + 120, exp: NOW_S + 700 })))).resolves.toBeDefined();
    expect(f.calls).toHaveLength(2);
    await rejects(verify(signJws(makeKey('k3'), claims({ jti: 'r3', iat: NOW_S + 120, exp: NOW_S + 700 }))), /unknown kid/);
    expect(f.calls).toHaveLength(2);
  });

  it('keeps serving cached keys when a refresh fails', async () => {
    const c = clock();
    let up = true;
    const f = fakeFetch({ 'jwks.json': () => (up ? { status: 200, body: { keys: [key.jwk] } } : { status: 500, body: {} }) });
    const jwks = new JwksCache(`https://p${JWKS_PATH}`, f.fn, c.now);
    await jwks.get('k1');
    up = false;
    c.advance(11 * 60_000);
    expect(await jwks.get('k1')).toBeDefined();
  });
});

describe('ReplayCache', () => {
  it('records, replays a final result, and forgets after 15 minutes', () => {
    const c = clock(NOW_MS);
    const r = new ReplayCache<string>(c.now);
    expect(r.claim('a')).toBeUndefined();
    const again = r.claim('a');
    expect(again).toBeDefined();
    expect(again?.result).toBeUndefined();
    r.complete('a', 'done');
    expect(r.claim('a')?.result).toBe('done');
    c.advance(15 * 60_000 + 1);
    expect(r.claim('a')).toBeUndefined();
  });
});
