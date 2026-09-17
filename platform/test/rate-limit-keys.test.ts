// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rate-limit key selection.
 *
 * The regression these lock down: `extractClientIp` used to prefer the raw
 * `X-Forwarded-For` header over `req.ip`, taking the LEFTMOST entry. Both
 * ingress configs append (`$proxy_add_x_forwarded_for`), so a client-supplied
 * value survives in position 0 — meaning a caller could vary the header per
 * request, land in a fresh bucket every time, and never trip the
 * 20-per-15-minute auth limiter on login/register/OAuth.
 *
 * These helpers all run BEFORE `requireAuth`, so each must also tolerate a
 * missing or malformed token without throwing.
 */

import type express from 'express';
import jwt from 'jsonwebtoken';

// The config module reads its secrets at import time and (correctly) throws
// when they're missing outside development — jest sets NODE_ENV=test, so the
// guards are live here. Set the env first, then import both modules
// dynamically; a static import would hoist above these assignments.
type Keys = typeof import('../src/middleware/rate-limit-keys.js');
type Cfg = typeof import('../src/config/index.js')['config'];

let extractClientIp: Keys['extractClientIp'];
let rateLimitKey: Keys['rateLimitKey'];
let peekJwtClaims: Keys['peekJwtClaims'];
let verifiedIsSuperAdmin: Keys['verifiedIsSuperAdmin'];
let tierLimitedMax: Keys['tierLimitedMax'];
let config: Cfg;

beforeAll(async () => {
  process.env.JWT_SECRET ||= 'test-jwt-secret-for-rate-limit-keys';
  process.env.REFRESH_TOKEN_SECRET ||= 'test-refresh-secret-for-rate-limit-keys';
  process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
  process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

  ({ config } = await import('../src/config/index.js'));
  ({ extractClientIp, rateLimitKey, peekJwtClaims, verifiedIsSuperAdmin, tierLimitedMax } =
    await import('../src/middleware/rate-limit-keys.js'));
});

/** A request with the fields these helpers touch. `ip` is what Express resolved. */
function req({ ip, headers = {} }: { ip?: string; headers?: Record<string, string> }): express.Request {
  return { ip, headers } as unknown as express.Request;
}

/** An UNSIGNED token carrying `payload` — what a forger can send. */
function bearer(payload: object): Record<string, string> {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { authorization: `Bearer header.${body}.sig` };
}

/** A validly signed access token carrying `payload`. */
function signed(payload: object): Record<string, string> {
  const token = jwt.sign({ type: 'access', ...payload }, config.auth.jwt.secret, { algorithm: config.auth.jwt.algorithm });
  return { authorization: `Bearer ${token}` };
}

describe('extractClientIp', () => {
  it('uses the IP Express resolved via `trust proxy`', () => {
    expect(extractClientIp(req({ ip: '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('IGNORES a client-supplied X-Forwarded-For — the limiter-bypass regression', () => {
    // nginx appends, so element 0 is attacker-controlled. Varying it must not
    // change the bucket, or the auth limiter never trips.
    const spoofed = extractClientIp(req({
      ip: '203.0.113.7',
      headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.7' },
    }));
    expect(spoofed).toBe('203.0.113.7');
  });

  it('gives one attacker the same bucket no matter what they prepend', () => {
    const keys = new Set(
      ['10.0.0.1', '10.0.0.2', '10.0.0.3', 'not-an-ip'].map((forged) =>
        extractClientIp(req({ ip: '203.0.113.7', headers: { 'x-forwarded-for': forged } })),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('normalizes IPv6 to a /64 prefix so rotating low bits cannot widen the bucket', () => {
    const a = extractClientIp(req({ ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }));
    const b = extractClientIp(req({ ip: '2001:db8:1:2:1111:2222:3333:4444' }));
    expect(a).toBe(b);
  });

  it('falls back to a constant when Express resolved no IP', () => {
    expect(extractClientIp(req({}))).toBe('unknown');
  });
});

describe('rateLimitKey', () => {
  it('buckets an authenticated caller by org', () => {
    expect(rateLimitKey(req({ ip: '203.0.113.7', headers: signed({ organizationId: 'Acme' }) })))
      .toBe('org:acme');
  });

  it('IGNORES an unverified organizationId — a random org per request must not mint fresh buckets', () => {
    const keys = new Set(['org-a', 'org-b', 'org-c'].map((organizationId) =>
      rateLimitKey(req({ ip: '203.0.113.7', headers: bearer({ type: 'access', organizationId }) }))));
    expect(keys).toEqual(new Set(['ip:203.0.113.7']));
  });

  it('does not bucket by a signed non-access token', () => {
    const token = jwt.sign({ type: 'step-up', organizationId: 'acme' }, config.auth.jwt.secret, { algorithm: config.auth.jwt.algorithm });
    expect(rateLimitKey(req({ ip: '203.0.113.7', headers: { authorization: `Bearer ${token}` } }))).toBe('ip:203.0.113.7');
  });

  it('falls back to IP keying with no token', () => {
    expect(rateLimitKey(req({ ip: '203.0.113.7' }))).toBe('ip:203.0.113.7');
  });

  it('falls back to IP keying on a malformed token rather than throwing', () => {
    for (const authorization of ['Bearer not.a.jwt', 'Bearer two.parts', 'Bearer ', 'Basic xyz']) {
      expect(rateLimitKey(req({ ip: '203.0.113.7', headers: { authorization } })))
        .toBe('ip:203.0.113.7');
    }
  });

  it('does not let a spoofed header split an anonymous caller across buckets', () => {
    const keys = new Set([
      rateLimitKey(req({ ip: '203.0.113.7', headers: { 'x-forwarded-for': '10.0.0.1' } })),
      rateLimitKey(req({ ip: '203.0.113.7', headers: { 'x-forwarded-for': '10.0.0.2' } })),
    ]);
    expect(keys).toEqual(new Set(['ip:203.0.113.7']));
  });
});

describe('peekJwtClaims', () => {
  it('reads claims without verifying (it runs pre-auth)', () => {
    expect(peekJwtClaims(req({ headers: bearer({ tier: 'team', isSuperAdmin: true }) })))
      .toEqual({ tier: 'team', isSuperAdmin: true });
  });

  it('returns {} for missing or malformed tokens', () => {
    expect(peekJwtClaims(req({}))).toEqual({});
    expect(peekJwtClaims(req({ headers: { authorization: 'Bearer a.b' } }))).toEqual({});
    expect(peekJwtClaims(req({ headers: { authorization: 'Bearer a.!!!.c' } }))).toEqual({});
  });
});

describe('verifiedIsSuperAdmin', () => {
  it('honours a properly signed sysadmin token', () => {
    expect(verifiedIsSuperAdmin(req({ headers: signed({ isSuperAdmin: true }) }))).toBe(true);
  });

  it('REFUSES an unsigned isSuperAdmin claim — the bypass removes throttling entirely', () => {
    expect(verifiedIsSuperAdmin(req({ headers: bearer({ isSuperAdmin: true }) }))).toBe(false);
  });

  it('refuses a token signed with the wrong secret', () => {
    const forged = jwt.sign({ isSuperAdmin: true }, 'not-the-secret', { algorithm: 'HS256' });
    expect(verifiedIsSuperAdmin(req({ headers: { authorization: `Bearer ${forged}` } }))).toBe(false);
  });

  it('refuses a signed token without the flag, and unauthenticated requests', () => {
    expect(verifiedIsSuperAdmin(req({ headers: signed({ sub: 'u1' }) }))).toBe(false);
    expect(verifiedIsSuperAdmin(req({}))).toBe(false);
  });
});

describe('tierLimitedMax', () => {
  it('scales the baseline by the tier multiplier', () => {
    const base = config.rateLimit.max;
    expect(tierLimitedMax(req({ headers: signed({ tier: 'developer' }) })))
      .toBe(Math.max(1, Math.floor(base * config.rateLimit.tierMultipliers.developer)));
    expect(tierLimitedMax(req({ headers: signed({ tier: 'enterprise' }) })))
      .toBe(Math.max(1, Math.floor(base * config.rateLimit.tierMultipliers.enterprise)));
  });

  it('IGNORES an unverified tier claim — a forged tier:"unlimited" gets the base budget', () => {
    expect(tierLimitedMax(req({ headers: bearer({ type: 'access', tier: 'unlimited' }) })))
      .toBe(Math.max(1, Math.floor(config.rateLimit.max)));
  });

  it('falls back to the developer baseline for an unknown or absent tier', () => {
    const fallback = Math.max(1, Math.floor(config.rateLimit.max * 1));
    expect(tierLimitedMax(req({ headers: signed({ tier: 'platinum' }) }))).toBe(fallback);
    expect(tierLimitedMax(req({}))).toBe(fallback);
  });

  it('never returns less than 1', () => {
    expect(tierLimitedMax(req({ headers: signed({ tier: 'developer' }) }))).toBeGreaterThanOrEqual(1);
  });
});
