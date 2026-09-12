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
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { _resetJwtSecretCacheForTests } from '../src/middleware/auth.js';
import { verifyStepUpToken, consumeStepUpJti, requireStepUp } from '../src/middleware/step-up.js';

const SECRET = 'step-up-test-secret';
const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  delete process.env.JWT_SECRET_PREVIOUS;
  delete process.env.JWT_ISSUER;
  delete process.env.JWT_AUDIENCE;
  delete process.env.JWT_ALGORITHM;
  // No REDIS_* → the process-local jti store is the one under test.
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_URL;
  // Secrets are cached for 5 minutes in auth.ts; drop the cache so the env
  // set above is what gets verified against.
  _resetJwtSecretCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

let jtiSeq = 0;
/** A signed step-up token. `jti` is unique per call so tests don't collide in
 *  the single-use store. */
function stepUpToken(over: Record<string, unknown> = {}, secret = SECRET, signOpts: jwt.SignOptions = {}) {
  jtiSeq += 1;
  return jwt.sign(
    { type: 'step-up', sub: 'user-1', jti: `jti-${jtiSeq}`, ...over },
    secret,
    { expiresIn: '60s', ...signOpts },
  );
}

describe('verifyStepUpToken', () => {
  it('accepts a well-formed step-up token', () => {
    const payload = verifyStepUpToken(stepUpToken());
    expect(payload.type).toBe('step-up');
    expect(payload.sub).toBe('user-1');
  });

  it('rejects a plain ACCESS token — it shares the secret and sub', () => {
    const access = jwt.sign({ sub: 'user-1', organizationId: 'org-1' }, SECRET, { expiresIn: '60s' });
    expect(() => verifyStepUpToken(access)).toThrow(/INVALID_STEP_UP_TOKEN/);
  });

  it('rejects a step-up token missing its jti', () => {
    const noJti = jwt.sign({ type: 'step-up', sub: 'user-1' }, SECRET, { expiresIn: '60s' });
    expect(() => verifyStepUpToken(noJti)).toThrow(/INVALID_STEP_UP_TOKEN/);
  });

  it('rejects a token signed with the wrong secret', () => {
    expect(() => verifyStepUpToken(stepUpToken({}, 'not-the-secret'))).toThrow();
  });

  it('refuses to run without JWT_SECRET', () => {
    const token = stepUpToken();
    delete process.env.JWT_SECRET;
    expect(() => verifyStepUpToken(token)).toThrow(/JWT_SECRET/);
  });

  describe('algorithm / issuer / audience pinning', () => {
    it('REGRESSION: rejects a token whose issuer does not match JWT_ISSUER', () => {
      // The hand-rolled verifier never pinned these, so a step-up token minted
      // by ANY other system sharing JWT_SECRET was accepted.
      const foreign = stepUpToken({}, SECRET, { issuer: 'some-other-system' });
      process.env.JWT_ISSUER = 'pipeline-builder';
      expect(() => verifyStepUpToken(foreign)).toThrow();
    });

    it('REGRESSION: rejects a token whose audience does not match JWT_AUDIENCE', () => {
      const foreign = stepUpToken({}, SECRET, { audience: 'some-other-audience' });
      process.env.JWT_AUDIENCE = 'pipeline-builder-api';
      expect(() => verifyStepUpToken(foreign)).toThrow();
    });

    it('accepts a token carrying the configured issuer and audience', () => {
      const token = stepUpToken({}, SECRET, { issuer: 'pipeline-builder', audience: 'pipeline-builder-api' });
      process.env.JWT_ISSUER = 'pipeline-builder';
      process.env.JWT_AUDIENCE = 'pipeline-builder-api';
      expect(verifyStepUpToken(token).sub).toBe('user-1');
    });
  });

  describe('secret rotation', () => {
    it('accepts a token signed with the PREVIOUS secret during a rotation', () => {
      const token = stepUpToken({}, 'old-secret');
      process.env.JWT_SECRET_PREVIOUS = 'old-secret';
      expect(verifyStepUpToken(token).sub).toBe('user-1');
    });

    it('REGRESSION: surfaces expiry as an expiry error, not a signature error', () => {
      // The old previous-secret retry had no expiry carve-out, so an EXPIRED
      // token was retried against the previous secret and reported as invalid.
      const expired = jwt.sign({ type: 'step-up', sub: 'user-1', jti: 'jti-exp' }, SECRET, { expiresIn: '-10s' });
      process.env.JWT_SECRET_PREVIOUS = 'old-secret';
      expect(() => verifyStepUpToken(expired)).toThrow(jwt.TokenExpiredError);
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
    const token = stepUpToken({ sub: 'user-1' });
    const next = jest.fn();
    const r = res();
    await requireStepUp(req({ user: { sub: 'user-1' }, headers: { 'x-step-up-token': token } }), r, next as never);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('401 STEP_UP_REQUIRED when the header is absent', async () => {
    const next = jest.fn();
    const r = res();
    await requireStepUp(req({ user: { sub: 'user-1' } }), r, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(401);
  });

  it('401 when the token belongs to a DIFFERENT user (no cross-session reuse)', async () => {
    const token = stepUpToken({ sub: 'user-2' });
    const next = jest.fn();
    const r = res();
    await requireStepUp(req({ user: { sub: 'user-1' }, headers: { 'x-step-up-token': token } }), r, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(401);
  });

  it('401 on the second use of the same token (single-use)', async () => {
    const token = stepUpToken({ sub: 'user-1' });
    const first = jest.fn();
    await requireStepUp(req({ user: { sub: 'user-1' }, headers: { 'x-step-up-token': token } }), res(), first as never);
    expect(first).toHaveBeenCalledTimes(1);

    const second = jest.fn();
    const r2 = res();
    await requireStepUp(req({ user: { sub: 'user-1' }, headers: { 'x-step-up-token': token } }), r2, second as never);
    expect(second).not.toHaveBeenCalled();
    expect(r2.statusCode).toBe(401);
  });

  it('401 when unauthenticated (must run after requireAuth)', async () => {
    const next = jest.fn();
    const r = res();
    await requireStepUp(req({ headers: { 'x-step-up-token': stepUpToken() } }), r, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(401);
  });

  it('EXEMPTS a verified service principal — step-up is a re-verify-the-human gate', async () => {
    const next = jest.fn();
    await requireStepUp(req({ user: { sub: 'service:pipeline' } }), res(), next as never);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
