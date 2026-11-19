// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The run-request signature: EdDSA compact JWS, the protocol's header and
 * claims, the public JWK set (RFC 7638 kids, two keys during a rotation), and
 * where the key comes from.
 */

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { ed25519Jwk, JwsVerifyError, okpThumbprint, signEdDsaJws, verifyEdDsaJws } from '../../src/runners/jws.js';
import { createRunRequestSigner, loadRunnerSigner, runnerSigningKeyConfigured } from '../../src/runners/signing.js';
import { claimsOf, headerOf } from '../helpers/runner-fakes.js';

const pem = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }).toString();
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

describe('loadRunnerSigner', () => {
  const a = generateKeyPairSync('ed25519').privateKey;
  const b = generateKeyPairSync('ed25519').privateKey;

  it('reads an inline PEM, or the _FILE, and a previous key when present', () => {
    expect(loadRunnerSigner({ RUNNER_SIGNING_KEY: pem(a) })?.jwks().keys).toHaveLength(1);
    const files: Record<string, string> = { '/k/cur': pem(a), '/k/prev': pem(b) };
    const read = (p: string) => { if (!(p in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return files[p]!; };
    expect(loadRunnerSigner({ RUNNER_SIGNING_KEY_FILE: '/k/cur', RUNNER_SIGNING_KEY_PREVIOUS_FILE: '/k/prev' }, read)?.jwks().keys).toHaveLength(2);
    // A missing previous file is "no rotation in progress".
    expect(loadRunnerSigner({ RUNNER_SIGNING_KEY_FILE: '/k/cur', RUNNER_SIGNING_KEY_PREVIOUS_FILE: '/k/none' }, read)?.jwks().keys).toHaveLength(1);
    expect(loadRunnerSigner({ RUNNER_SIGNING_KEY_FILE: '/k/cur', RUNNER_SIGNING_KEY_PREVIOUS_FILE: '' }, read)?.jwks().keys).toHaveLength(1);
  });

  it('is null (runners unavailable) with no key, a missing file, a non-Ed25519 key or an unreadable one', () => {
    expect(loadRunnerSigner({})).toBeNull();
    expect(loadRunnerSigner({ RUNNER_SIGNING_KEY_FILE: '/none' }, () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); })).toBeNull();
    expect(loadRunnerSigner({ RUNNER_SIGNING_KEY_FILE: '/k' }, () => '  ')).toBeNull();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    expect(loadRunnerSigner({ RUNNER_SIGNING_KEY: pem(ec) })).toBeNull();
    expect(loadRunnerSigner({ RUNNER_SIGNING_KEY: 'not a pem' })).toBeNull();
    expect(loadRunnerSigner({ RUNNER_SIGNING_KEY_FILE: '/k' }, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); })).toBeNull();
  });
});

describe('runnerSigningKeyConfigured (readiness)', () => {
  it('a deployment is runner-ready only with a key configured', () => {
    expect(runnerSigningKeyConfigured({})).toBe(false);
    expect(runnerSigningKeyConfigured({ RUNNER_SIGNING_KEY_FILE: ' ' })).toBe(false);
    expect(runnerSigningKeyConfigured({ RUNNER_SIGNING_KEY_FILE: '/k' })).toBe(true);
    expect(runnerSigningKeyConfigured({ RUNNER_SIGNING_KEY: 'pem' })).toBe(true);
  });
});
