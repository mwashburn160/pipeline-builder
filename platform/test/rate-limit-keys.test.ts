// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rate-limit key selection.
 *
 * What these lock down: `extractClientIp` must never prefer the raw
 * `X-Forwarded-For` header over `req.ip` (its LEFTMOST entry). Both
 * ingress configs append (`$proxy_add_x_forwarded_for`), so a client-supplied
 * value survives in position 0 — meaning a caller could vary the header per
 * request, land in a fresh bucket every time, and never trip the
 * 20-per-15-minute auth limiter on login/register/OAuth.
 *
 * These helpers all run BEFORE `requireAuth`, so each must also tolerate a
 * missing or malformed token without throwing.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
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
let scimOrgKey: Keys['scimOrgKey'];
let verifiedIsSuperAdmin: Keys['verifiedIsSuperAdmin'];
let tierLimitedMax: Keys['tierLimitedMax'], isSignOut: typeof import('../src/middleware/rate-limit-keys.js')['isSignOut'];
let config: Cfg;
/** Signs the ES256 user tokens these helpers verify. */
let signUserToken: (payload: Record<string, unknown>) => Promise<string>;

beforeAll(async () => {
  process.env.JWT_SECRET ||= 'test-jwt-secret-for-rate-limit-keys';
  process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
  process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

  ({ config } = await import('../src/config/index.js'));
  ({ extractClientIp, rateLimitKey, peekJwtClaims, scimOrgKey, verifiedIsSuperAdmin, tierLimitedMax, isSignOut } =
    await import('../src/middleware/rate-limit-keys.js'));

  // Bucket selection verifies the token, so it needs platform's signing key
  // loaded (in memory here — no PEM, no KMS).
  const { installTestSigningKeys } = await import('./helpers/signing.js');
  installTestSigningKeys();
  const { signUserJwt } = await import('../src/services/token-signing/index.js');
  signUserToken = (payload) => signUserJwt(payload, { expiresIn: 300 });
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

/** A validly signed (ES256, platform-signed) access token carrying `payload`. */
async function signed(payload: Record<string, unknown>): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await signUserToken({ type: 'access', ...payload })}` };
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
  it('buckets an authenticated caller by org', async () => {
    expect(rateLimitKey(req({ ip: '203.0.113.7', headers: await signed({ organizationId: 'Acme' }) })))
      .toBe('org:acme');
  });

  it('IGNORES an unverified organizationId — a random org per request must not mint fresh buckets', () => {
    const keys = new Set(['org-a', 'org-b', 'org-c'].map((organizationId) =>
      rateLimitKey(req({ ip: '203.0.113.7', headers: bearer({ type: 'access', organizationId }) }))));
    expect(keys).toEqual(new Set(['ip:203.0.113.7']));
  });

  it('does not bucket by a signed non-access token', async () => {
    const headers = await signed({ type: 'step-up', organizationId: 'acme' });
    expect(rateLimitKey(req({ ip: '203.0.113.7', headers }))).toBe('ip:203.0.113.7');
  });

  it('falls back to IP keying with no token', () => {
    expect(rateLimitKey(req({ ip: '203.0.113.7' }))).toBe('ip:203.0.113.7');
  });

  it('buckets a SERVICE ACCOUNT by the account, not by its org', async () => {
    const headers = await signed({ organizationId: 'acme', principalType: 'service_account', sub: 'sa-1' });
    // Automation is exactly the traffic that would otherwise drain the window
    // its org's people share — so it gets its own bucket.
    expect(rateLimitKey(req({ ip: '203.0.113.7', headers }))).toBe('sa:sa-1');
  });

  it('buckets an OPAQUE key by the key hash, which is per-credential (pre-auth)', async () => {
    const key = 'pb_sa_0123456789abcdef0123456789abcdef0123456789a';
    const other = 'pb_pat_0123456789abcdef0123456789abcdef0123456789b';
    const bucket = rateLimitKey(req({ ip: '203.0.113.7', headers: { authorization: `Bearer ${key}` } }));

    // Stable per key, distinct per key, and never the secret itself.
    expect(bucket).toBe(rateLimitKey(req({ ip: '198.51.100.1', headers: { authorization: `Bearer ${key}` } })));
    expect(bucket).not.toBe(rateLimitKey(req({ ip: '203.0.113.7', headers: { authorization: `Bearer ${other}` } })));
    expect(bucket.startsWith('key:')).toBe(true);
    expect(bucket).not.toContain(key.slice(6));
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

describe('scimOrgKey', () => {
  it('buckets by ORG, not by the service account — the plan asks for a per-org limit', async () => {
    // Deliberately the opposite of `rateLimitKey`: an org that mints five SCIM
    // keys must still get ONE directory-sync budget, or the ceiling is raised
    // just by issuing more keys.
    const a = await signed({ organizationId: 'Acme', principalType: 'service_account', sub: 'sa-1' });
    const b = await signed({ organizationId: 'acme', principalType: 'service_account', sub: 'sa-2' });
    expect(scimOrgKey(req({ ip: '203.0.113.7', headers: a }))).toBe('scim-org:acme');
    expect(scimOrgKey(req({ ip: '198.51.100.1', headers: b }))).toBe('scim-org:acme');
  });

  it('IGNORES an unverified org claim', () => {
    const keys = new Set(['org-a', 'org-b'].map((organizationId) =>
      scimOrgKey(req({ ip: '203.0.113.7', headers: bearer({ type: 'access', organizationId }) }))));
    expect(keys).toEqual(new Set(['scim-ip:203.0.113.7']));
  });

  it('falls back to the credential hash, then the IP', () => {
    const key = 'pb_sa_0123456789abcdef0123456789abcdef0123456789a';
    const bucket = scimOrgKey(req({ ip: '203.0.113.7', headers: { authorization: `Bearer ${key}` } }));
    expect(bucket.startsWith('scim-key:')).toBe(true);
    expect(bucket).not.toContain(key.slice(6));
    expect(scimOrgKey(req({ ip: '203.0.113.7' }))).toBe('scim-ip:203.0.113.7');
  });

  it('never collides with the general bucket for the same org', async () => {
    const headers = await signed({ organizationId: 'acme' });
    expect(scimOrgKey(req({ ip: '203.0.113.7', headers })))
      .not.toBe(rateLimitKey(req({ ip: '203.0.113.7', headers })));
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
  it('honours a properly signed sysadmin token', async () => {
    expect(verifiedIsSuperAdmin(req({ headers: await signed({ isSuperAdmin: true }) }))).toBe(true);
  });

  it('REFUSES an unsigned isSuperAdmin claim — the bypass removes throttling entirely', () => {
    expect(verifiedIsSuperAdmin(req({ headers: bearer({ isSuperAdmin: true }) }))).toBe(false);
  });

  it('refuses an HS256 token, whatever secret signed it', () => {
    // There is no shared secret left  — and an HMAC token cannot buy a
    // rate-limit bypass on either chain.
    const forged = jwt.sign({ type: 'access', isSuperAdmin: true }, 'any-shared-secret', { algorithm: 'HS256' });
    expect(verifiedIsSuperAdmin(req({ headers: { authorization: `Bearer ${forged}` } }))).toBe(false);
  });

  it('refuses a signed token without the flag, and unauthenticated requests', async () => {
    expect(verifiedIsSuperAdmin(req({ headers: await signed({ sub: 'u1' }) }))).toBe(false);
    expect(verifiedIsSuperAdmin(req({}))).toBe(false);
  });
});

describe('tierLimitedMax', () => {
  it('scales the baseline by the tier multiplier', async () => {
    const base = config.rateLimit.max;
    expect(tierLimitedMax(req({ headers: await signed({ tier: 'developer' }) })))
      .toBe(Math.max(1, Math.floor(base * config.rateLimit.tierMultipliers.developer)));
    expect(tierLimitedMax(req({ headers: await signed({ tier: 'enterprise' }) })))
      .toBe(Math.max(1, Math.floor(base * config.rateLimit.tierMultipliers.enterprise)));
  });

  it('IGNORES an unverified tier claim — a forged tier:"unlimited" gets the base budget', () => {
    expect(tierLimitedMax(req({ headers: bearer({ type: 'access', tier: 'unlimited' }) })))
      .toBe(Math.max(1, Math.floor(config.rateLimit.max)));
  });

  it('falls back to the developer baseline for an unknown or absent tier', async () => {
    const fallback = Math.max(1, Math.floor(config.rateLimit.max * 1));
    expect(tierLimitedMax(req({ headers: await signed({ tier: 'platinum' }) }))).toBe(fallback);
    expect(tierLimitedMax(req({}))).toBe(fallback);
  });

  it('never returns less than 1', async () => {
    expect(tierLimitedMax(req({ headers: await signed({ tier: 'developer' }) }))).toBeGreaterThanOrEqual(1);
  });
});

describe('isSignOut — sign-out is exempt from the auth limiter', () => {
  // The shared `req()` above models only ip/headers; this predicate reads
  // method + path, so it gets its own minimal request.
  const call = (method: string, path: string) => ({ method, path }) as unknown as express.Request;

  // Being rate-limited out of LEAVING, and then out of signing back in, was a
  // real lockout: the app asks /auth/sso/logout for an SLO redirect before
  // /auth/logout, so one sign-out spent two of the per-IP budget.
  it('matches both sign-out paths', () => {
    expect(isSignOut(call('POST', '/auth/logout'))).toBe(true);
    expect(isSignOut(call('POST', '/auth/sso/logout'))).toBe(true);
  });

  it('does NOT exempt the credential-guessing surface it defends', () => {
    for (const path of ['/auth/login', '/auth/register', '/auth/webauthn/login/options', '/auth/webauthn/login/verify', '/auth/step-up']) {
      expect(isSignOut(call('POST', path))).toBe(false);
    }
  });

  it('is POST-only, so a GET cannot slip past the limiter on the same path', () => {
    expect(isSignOut(call('GET', '/auth/logout'))).toBe(false);
  });
});
