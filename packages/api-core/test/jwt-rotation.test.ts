// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zero-downtime rotation, for both signing chains.
 *
 * USER tokens (access, refresh, step-up, exchanged keys) are ES256 signed by
 * platform and rotated BY `kid`: the JWKS publishes the incoming key alongside
 * the retiring one, so tokens minted before and after the cutover both verify.
 * A verifier also refetches once on an unknown `kid`, which is what lets a
 * freshly rotated-in key work without restarting the fleet, and it FAILS CLOSED
 * when the key set cannot be obtained at all.
 *
 * INTERNAL SERVICE tokens rotate the same way since #14, just against a
 * different key set: each service signs with its OWN key and the shared bundle
 * publishes the retiring public key alongside the incoming one. The key loader
 * caches the bundle at module scope, so those tests load a FRESH copy
 * (jest.resetModules + dynamic import) after rewriting it.
 *
 * The other half of the contract — that a token claiming to be a USER is only
 * ever accepted from platform's signing key — lives in auth-middleware.test.ts.
 */

import { jest, describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';

import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../src/middleware/auth.js';
import { installTestServiceKeys, type TestServiceKeysHandle } from '../src/testing/service-tokens.js';
import {
  generateTestSigningKey, installTestJwks, signTestUserToken, testUserIdentityClaims, uninstallTestJwks,
  type TestJwksHandle, type TestSigningKey,
} from '../src/testing/user-tokens.js';
import { ErrorCode } from '../src/types/error-codes.js';

/** requireAuth fails closed without the identity claims (principalType / token_use
 *  / assurance), so every payload here carries them like a real mint does. */
const SERVICE = { type: 'access', role: 'member', principalType: 'service', token_use: 'access' };

function createMockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, user: undefined, ...overrides } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: any } {
  const res = {
    _status: 0,
    _json: null as any,
    headersSent: false,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._json = body; return res; },
  };
  return res as unknown as Response & { _status: number; _json: any };
}

/** Load a fresh auth module so its module-scoped SERVICE-secret cache reflects env. */
async function loadAuth() {
  jest.resetModules();
  return import('../src/middleware/auth.js');
}

function bearer(token: string): Request {
  return createMockReq({ headers: { authorization: `Bearer ${token}` } });
}

/** Run requireAuth to a terminal state: next(), or a response. */
function runAuth(req: Request): Promise<{ status: number; code?: string; passed: boolean }> {
  return new Promise((resolve) => {
    const res = createMockRes();
    const origJson = res.json.bind(res);
    (res as any).json = (body: any) => {
      const out = origJson(body);
      resolve({ status: res._status, code: body?.code, passed: false });
      return out;
    };
    requireAuth(req, res, () => resolve({ status: 0, passed: true }));
  });
}

const userClaims = (sub: string) => ({ ...testUserIdentityClaims(), sub, role: 'member' });

afterAll(() => uninstallTestJwks());

describe('user-token rotation by kid', () => {
  let incoming: TestSigningKey;
  let retiring: TestSigningKey;
  let jwks: TestJwksHandle;

  beforeEach(() => {
    incoming = generateTestSigningKey();
    retiring = generateTestSigningKey();
    // The overlap window: platform signs with `incoming` and keeps publishing
    // `retiring`, so nothing minted before the cutover stops working.
    jwks = installTestJwks([incoming, retiring]);
  });

  it('accepts a token signed with the RETIRING key while it is still published', async () => {
    const token = await signTestUserToken(userClaims('user1'), { key: retiring });
    const out = await runAuth(bearer(token));
    expect(out.passed).toBe(true);
  });

  it('accepts a token signed with the INCOMING key in the same window', async () => {
    const token = await signTestUserToken(userClaims('user2'), { key: incoming });
    expect((await runAuth(bearer(token))).passed).toBe(true);
  });

  it('REJECTS the retiring key once the rotation is finished (it is no longer published)', async () => {
    const token = await signTestUserToken(userClaims('user1'), { key: retiring });
    jwks.publish([incoming]);
    // Force the cache past its refresh interval so it picks up the new set.
    const fresh = installTestJwks([incoming]);
    expect(fresh.primary.kid).toBe(incoming.kid);
    const out = await runAuth(bearer(token));
    expect(out).toMatchObject({ passed: false, status: 401, code: ErrorCode.TOKEN_INVALID });
  });

  it('refetches ONCE on an unknown kid, so a just-rotated-in key works without a restart', async () => {
    const onlyOld = installTestJwks([retiring]);
    // Warm the cache so the unknown-kid path is what triggers the refetch.
    await runAuth(bearer(await signTestUserToken(userClaims('warm'), { key: retiring })));
    const fetchesBefore = onlyOld.fetchCount();

    // Platform rotates: it now signs with a key the verifier has never seen.
    onlyOld.publish([incoming, retiring]);
    const token = await signTestUserToken(userClaims('user3'), { key: incoming });

    expect((await runAuth(bearer(token))).passed).toBe(true);
    expect(onlyOld.fetchCount()).toBe(fetchesBefore + 1);
  });

  it('does not refetch again for the SAME unknown kid inside the cooldown', async () => {
    const handle = installTestJwks([retiring], { unknownKidCooldownMs: 60_000 });
    await runAuth(bearer(await signTestUserToken(userClaims('warm'), { key: retiring })));
    const before = handle.fetchCount();

    // A forged kid must not turn every request into a fetch against platform.
    const forged = await signTestUserToken(userClaims('user4'), { key: incoming });
    expect((await runAuth(bearer(forged))).passed).toBe(false);
    expect((await runAuth(bearer(forged))).passed).toBe(false);
    expect(handle.fetchCount()).toBe(before + 1);
  });

  it('rejects a token whose header names no kid', async () => {
    const parts = (await signTestUserToken(userClaims('user5'), { key: incoming })).split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' }), 'utf-8').toString('base64url');
    const out = await runAuth(bearer(`${header}.${parts[1]}.${parts[2]}`));
    expect(out).toMatchObject({ passed: false, status: 401 });
  });

  it('rejects a token signed by a key that was never published', async () => {
    const foreign = generateTestSigningKey();
    const token = await signTestUserToken(userClaims('user6'), { key: foreign });
    expect((await runAuth(bearer(token))).passed).toBe(false);
  });

  it('rejects a token whose kid matches a published key but whose signature does not', async () => {
    // Signed by the retiring key, labelled with the incoming key's kid — the
    // check that makes `kid` a lookup hint rather than a trust statement.
    const token = await signTestUserToken(userClaims('user7'), { key: retiring, kid: incoming.kid });
    expect((await runAuth(bearer(token))).passed).toBe(false);
  });

  it('still enforces expiry — an expired token surfaces as EXPIRED, not invalid', async () => {
    const token = await signTestUserToken(userClaims('user8'), { key: incoming, expiresIn: -1 });
    const out = await runAuth(bearer(token));
    expect(out).toMatchObject({ passed: false, status: 401, code: ErrorCode.TOKEN_EXPIRED });
  });

  it('serves a CACHED key set while a refresh is failing (public keys do not expire)', async () => {
    const handle = installTestJwks([incoming], { refreshIntervalMs: 0 });
    const token = await signTestUserToken(userClaims('user9'), { key: incoming });
    expect((await runAuth(bearer(token))).passed).toBe(true);
    handle.failNextFetches(10);
    // Refusing every request because platform blipped would be a self-inflicted
    // outage; the keys already in hand stay usable.
    expect((await runAuth(bearer(token))).passed).toBe(true);
  });

  it('FAILS CLOSED with 503 when no key set has ever been obtained', async () => {
    const handle = installTestJwks([incoming]);
    handle.failNextFetches(10);
    const token = await signTestUserToken(userClaims('user10'), { key: incoming });
    const out = await runAuth(bearer(token));
    expect(out).toMatchObject({ passed: false, status: 503 });
  });

  it('rejects a garbage token', async () => {
    const out = await runAuth(bearer('not.a.jwt'));
    expect(out).toMatchObject({ passed: false, status: 401, code: ErrorCode.TOKEN_INVALID });
  });
});

describe('service-token rotation — per-service keys (#14)', () => {
  let keys: TestServiceKeysHandle;

  beforeEach(() => { keys = installTestServiceKeys(['billing', 'billing-next', 'compliance']); });
  afterEach(() => keys.uninstall());

  it('accepts a token signed with the RETIRING key while the bundle still publishes it', async () => {
    // `billing-next` stands in for billing's INCOMING key; publishing both under
    // the name `billing` is the overlap window.
    keys.publishKeys({ billing: [keys.keys.get('billing')!, keys.keys.get('billing-next')!] });
    const { verifyServicePrincipal } = await loadAuth();
    expect(verifyServicePrincipal(bearer(keys.sign('billing')))).toBe(true);
  });

  it('rejects a token whose key is no longer published', async () => {
    const retired = keys.sign('billing');
    keys.publish(['compliance']);
    const { verifyServicePrincipal } = await loadAuth();
    expect(verifyServicePrincipal(bearer(retired))).toBe(false);
  });

  it('refuses a token signed by ANOTHER service, however valid its own key is', async () => {
    const { verifyServicePrincipal } = await loadAuth();
    // `sub: service:billing`, signed with compliance's key. This is the forgery
    // the shared secret could never detect.
    expect(verifyServicePrincipal(bearer(keys.signAs('compliance', 'billing')))).toBe(false);
  });

  it('never accepts an ES256 user token as a service principal', async () => {
    const key = generateTestSigningKey();
    installTestJwks([key]);
    const { verifyServicePrincipal } = await loadAuth();
    const token = await signTestUserToken(userClaims('user1'), { key });
    expect(verifyServicePrincipal(bearer(token))).toBe(false);
  });

  it('never accepts an HS256 token, whatever secret signed it', async () => {
    const { verifyServicePrincipal } = await loadAuth();
    const token = jwt.sign({ ...SERVICE, sub: 'service:billing' }, 'any-shared-secret');
    expect(verifyServicePrincipal(bearer(token))).toBe(false);
  });
});
