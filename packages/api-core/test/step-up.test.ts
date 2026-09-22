// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireStepUp` — the step-up (recent-password-reverify) gate shared by every
 * api service.
 *
 * `step-up-middleware.test.ts` covers the happy path and basic rejections; this
 * file covers the SECURITY boundary that had no coverage, which is how the
 * hand-rolled JWT verification here drifted from `requireAuth`'s and quietly
 * lost two of its guards: issuer/audience pinning, and the expiry carve-out on
 * the previous-secret retry. Plus the single-use store's size bound.
 *
 * A step-up token is a USER token, so since #5 it is ES256 signed by platform
 * and verified against the published JWKS — the same chain and the same `kid`
 * rotation as an access token. No shared secret can mint one, which is asserted
 * below.
 */

import type { AnyFn } from '../src/testing/any-fn.js';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { verifyStepUpToken, consumeStepUpJti, requireStepUp } from '../src/middleware/step-up.js';
import {
  generateTestSigningKey, installTestJwks, signTestUserToken, uninstallTestJwks,
  type TestSigningKey,
} from '../src/testing/user-tokens.js';

const SECRET = 'step-up-test-secret';
const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.JWT_ISSUER;
  delete process.env.JWT_AUDIENCE;
  delete process.env.JWT_ALGORITHM;
  // No REDIS_* → the process-local jti store is the one under test.
  delete process.env.REDIS_SENTINELS;
  delete process.env.REDIS_URL;
  signingKey = generateTestSigningKey();
  installTestJwks([signingKey]);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  uninstallTestJwks();
});

let signingKey: TestSigningKey;
let jtiSeq = 0;
/** A signed step-up token. `jti` is unique per call so tests don't collide in
 *  the single-use store. */
function stepUpToken(
  over: Record<string, unknown> = {},
  signOpts: { key?: TestSigningKey; expiresIn?: number; issuer?: string; audience?: string } = {},
): string {
  jtiSeq += 1;
  return signTestUserToken(
    { type: 'step-up', sub: 'user-1', jti: `jti-${jtiSeq}`, ...over },
    { key: signOpts.key ?? signingKey, expiresIn: signOpts.expiresIn ?? 60, ...signOpts },
  );
}

describe('verifyStepUpToken', () => {
  it('accepts a well-formed step-up token', async () => {
    const payload = await verifyStepUpToken(await stepUpToken());
    expect(payload.type).toBe('step-up');
    expect(payload.sub).toBe('user-1');
  });

  it('rejects a plain ACCESS token — it shares the signing key and sub', async () => {
    const access = await signTestUserToken({ sub: 'user-1', organizationId: 'org-1' }, { key: signingKey, expiresIn: 60 });
    await expect(verifyStepUpToken(access)).rejects.toThrow(/INVALID_STEP_UP_TOKEN/);
  });

  it('rejects a step-up token missing its jti', async () => {
    const noJti = await signTestUserToken({ type: 'step-up', sub: 'user-1' }, { key: signingKey, expiresIn: 60 });
    await expect(verifyStepUpToken(noJti)).rejects.toThrow(/INVALID_STEP_UP_TOKEN/);
  });

  it('rejects a token signed with an unpublished key', async () => {
    await expect(verifyStepUpToken(await stepUpToken({}, { key: generateTestSigningKey() }))).rejects.toThrow();
  });

  it('REJECTS an HS256 step-up token minted with a shared secret', async () => {
    // Before #5 any service holding JWT_SECRET could mint a step-up token and
    // clear its own step-up gates.
    const forged = jwt.sign({ type: 'step-up', sub: 'user-1', jti: 'jti-hs256' }, SECRET, { expiresIn: '60s' });
    await expect(verifyStepUpToken(forged)).rejects.toThrow();
  });

  describe('issuer / audience pinning', () => {
    it('REGRESSION: rejects a token whose issuer does not match JWT_ISSUER', async () => {
      // The hand-rolled verifier never pinned these, so a step-up token minted
      // by ANY other system sharing the signing material was accepted.
      const foreign = await stepUpToken({}, { issuer: 'some-other-system' });
      process.env.JWT_ISSUER = 'pipeline-builder';
      await expect(verifyStepUpToken(foreign)).rejects.toThrow();
    });

    it('REGRESSION: rejects a token whose audience does not match JWT_AUDIENCE', async () => {
      const foreign = await stepUpToken({}, { audience: 'some-other-audience' });
      process.env.JWT_AUDIENCE = 'pipeline-builder-api';
      await expect(verifyStepUpToken(foreign)).rejects.toThrow();
    });

    it('accepts a token carrying the configured issuer and audience', async () => {
      const token = await stepUpToken({}, { issuer: 'pipeline-builder', audience: 'pipeline-builder-api' });
      process.env.JWT_ISSUER = 'pipeline-builder';
      process.env.JWT_AUDIENCE = 'pipeline-builder-api';
      expect((await verifyStepUpToken(token)).sub).toBe('user-1');
    });
  });

  describe('key rotation by kid', () => {
    it('accepts a token signed with the RETIRING key while it is still published', async () => {
      const retiring = generateTestSigningKey();
      installTestJwks([signingKey, retiring]);
      const token = await stepUpToken({}, { key: retiring });
      expect((await verifyStepUpToken(token)).sub).toBe('user-1');
    });

    it('surfaces expiry as an expiry error, not a signature error', async () => {
      const expired = await stepUpToken({}, { expiresIn: -10 });
      await expect(verifyStepUpToken(expired)).rejects.toThrow(jwt.TokenExpiredError);
    });

    it('FAILS CLOSED when the signing keys cannot be fetched', async () => {
      const token = await stepUpToken();
      const handle = installTestJwks([signingKey]);
      handle.failNextFetches(5);
      await expect(verifyStepUpToken(token)).rejects.toThrow();
    });
  });
});

describe('consumeStepUpJti (process-local store)', () => {
  const exp = () => Math.floor(Date.now() / 1000) + 60;

  it('claims a jti once and rejects the replay', async () => {
    expect(await consumeStepUpJti('jti-single', exp())).toBe(true);
    expect(await consumeStepUpJti('jti-single', exp())).toBe(false);
  });

  it('treats distinct jtis independently', async () => {
    expect(await consumeStepUpJti('jti-a', exp())).toBe(true);
    expect(await consumeStepUpJti('jti-b', exp())).toBe(true);
  });

  it('stays bounded under a flood of distinct jtis', async () => {
    // The 30s sweep alone can't bound the map — entries only leave once their
    // TTL passes, so a burst outruns it. Shedding the oldest is safe: token
    // `exp` still enforces expiry independently.
    for (let i = 0; i < 11_000; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design: testing the cap
      await consumeStepUpJti(`flood-${i}`, exp());
    }
    // The most recent claim must still be remembered (replay still rejected).
    expect(await consumeStepUpJti('flood-10999', exp())).toBe(false);
  });
});

describe('requireStepUp', () => {
  function res() {
    const r = { statusCode: 0, body: undefined as unknown } as unknown as Response & { statusCode: number; body: unknown };
    r.status = jest.fn((code: number) => { r.statusCode = code; return r; }) as never;
    r.json = jest.fn((b: unknown) => { r.body = b; return r; }) as never;
    return r;
  }
  const req = (over: Record<string, unknown> = {}) =>
    ({ headers: {}, ...over } as unknown as Request);

  it('passes a valid, caller-bound token', async () => {
    const token = await stepUpToken({ sub: 'user-1' });
    const next = jest.fn<AnyFn>();
    const r = res();
    await requireStepUp(req({ user: { sub: 'user-1' }, headers: { 'x-step-up-token': token } }), r, next as never);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('401 STEP_UP_REQUIRED when the header is absent', async () => {
    const next = jest.fn<AnyFn>();
    const r = res();
    await requireStepUp(req({ user: { sub: 'user-1' } }), r, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(401);
  });

  it('401 when the token belongs to a DIFFERENT user (no cross-session reuse)', async () => {
    const token = await stepUpToken({ sub: 'user-2' });
    const next = jest.fn<AnyFn>();
    const r = res();
    await requireStepUp(req({ user: { sub: 'user-1' }, headers: { 'x-step-up-token': token } }), r, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(401);
  });

  it('401 on the second use of the same token (single-use)', async () => {
    const token = await stepUpToken({ sub: 'user-1' });
    const first = jest.fn<AnyFn>();
    await requireStepUp(req({ user: { sub: 'user-1' }, headers: { 'x-step-up-token': token } }), res(), first as never);
    expect(first).toHaveBeenCalledTimes(1);

    const second = jest.fn<AnyFn>();
    const r2 = res();
    await requireStepUp(req({ user: { sub: 'user-1' }, headers: { 'x-step-up-token': token } }), r2, second as never);
    expect(second).not.toHaveBeenCalled();
    expect(r2.statusCode).toBe(401);
  });

  it('401 when unauthenticated (must run after requireAuth)', async () => {
    const next = jest.fn<AnyFn>();
    const r = res();
    await requireStepUp(req({ headers: { 'x-step-up-token': await stepUpToken() } }), r, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(401);
  });

  it('EXEMPTS a verified service principal — step-up is a re-verify-the-human gate', async () => {
    const next = jest.fn<AnyFn>();
    await requireStepUp(req({ user: { sub: 'service:pipeline', principalType: 'service' } }), res(), next as never);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
