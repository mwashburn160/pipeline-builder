// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';

import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  requireAuth, isSystemAdmin,
  signServiceToken, getServiceAuthHeader, isServicePrincipal, verifyServicePrincipal,
  requirePermission, requireSystemAdmin, setAuthzDenialAuditor,
  requireAllPermissions, setTokenRevocationStore, requireFeature, isAccessTokenRevoked,
} from '../src/middleware/auth.js';
import type { AuthzDenialInfo } from '../src/middleware/auth.js';
import { verifyServiceJwt } from '../src/services/service-keys.js';
import { installTestServiceKeys, type TestServiceKeysHandle } from '../src/testing/service-tokens.js';
import {
  installTestJwks, signTestUserToken, testUserIdentityClaims, uninstallTestJwks,
  type TestJwksHandle,
} from '../src/testing/user-tokens.js';
import type { JwtPayload } from '../src/types/common.js';

const TEST_SECRET = 'test-jwt-secret-for-unit-tests';

// Two independent ES256 chains: USER tokens against the JWKS installed below
// (in-memory, no HTTP), INTERNAL SERVICE tokens against the per-service key
// bundle (#14). `TEST_SECRET` survives only to mint the HMAC tokens that must
// now be refused on BOTH chains.
let jwks: TestJwksHandle;
let serviceKeys: TestServiceKeysHandle;
beforeAll(() => {
  serviceKeys = installTestServiceKeys(['billing', 'platform', 'compliance', 'plugin', 'evil']);
});
beforeEach(() => { jwks = installTestJwks(); });
afterAll(() => { uninstallTestJwks(); serviceKeys.uninstall(); });

/** Mint a service token AS `serviceName`, the way that service's process would. */
function serviceToken(serviceName: string, opts: Omit<Parameters<typeof signServiceToken>[0], 'serviceName'>): string {
  serviceKeys.becomeService(serviceName);
  return signServiceToken({ serviceName, ...opts });
}

/**
 * Let `requireAuth` finish. Verifying a USER token is asynchronous now (it
 * resolves the signing key through the JWKS cache), so a synchronous assert
 * right after the call would run before the middleware decided anything.
 */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Sign a USER access token with the installed test key. */
function userToken(payload: Record<string, unknown> = {}, options: { expiresIn?: number } = {}): Promise<string> {
  return signTestUserToken(
    { ...testUserIdentityClaims(), sub: 'user1', role: 'member', ...payload },
    { key: jwks.primary, ...options },
  );
}

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    user: undefined,
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._json = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

function signToken(payload: Record<string, unknown>, options?: jwt.SignOptions): string {
  return jwt.sign(payload, TEST_SECRET, options);
}

/**
 * The identity claims every USER token must carry (`principalType`/`token_use`
 * plus the assurance trio). requireAuth fails closed without them, so test
 * payloads spread this in exactly as the platform mints it.
 */
const USER_CLAIMS = {
  principalType: 'user',
  token_use: 'access',
  amr: ['pwd'],
  aal: 1,
  auth_time: 1_700_000_000,
} as const;

// requireAuth

describe('requireAuth', () => {
  it('should reject request with no Authorization header', () => {
    const req = createMockReq();
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject malformed Authorization header', () => {
    const req = createMockReq({ headers: { authorization: 'Basic abc123' } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject expired token', async () => {
    const token = await userToken({}, { expiresIn: -1 });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);
    await settle();

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject invalid token', async () => {
    const req = createMockReq({ headers: { authorization: 'Bearer invalid.token.here' } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);
    await settle();

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('REJECTS an HS256 token that claims to be a user — the whole point of asymmetric signing', async () => {
    // Signed with the shared secret EVERY service holds, and shaped exactly like
    // a platform access token. Before #5 this was indistinguishable from the real
    // thing, so any one service could mint a platform-admin session.
    const token = signToken({ type: 'access', sub: 'user1', role: 'owner', isSuperAdmin: true, ...USER_CLAIMS });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);
    await settle();

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('REJECTS an ES256 token that claims to be a service principal', async () => {
    // The converse: the user signing key may not mint an internal identity, or a
    // stolen platform key would also grant service-only routes.
    const token = await signTestUserToken(
      { type: 'access', sub: 'service:billing', principalType: 'service', token_use: 'access', role: 'member' },
      { key: jwks.primary },
    );
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);
    await settle();

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 503 (never a pass) when the signing keys cannot be fetched', async () => {
    // Fail CLOSED and retryably: an unverifiable token is not an identity, and a
    // 401 would send a legitimate client off to re-authenticate over our outage.
    const fresh = installTestJwks(undefined, { negativeTtlMs: 50 });
    fresh.failNextFetches(5);
    const token = await signTestUserToken({ ...testUserIdentityClaims(), sub: 'user1', role: 'member' }, { key: fresh.primary });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);
    await settle();

    expect(res._status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject non-access token type', async () => {
    const token = await userToken({ type: 'refresh' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);
    await settle();

    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept valid access token and attach user', async () => {
    const token = await userToken({ organizationId: 'org1' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);
    await settle();

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user!.sub).toBe('user1');
    expect(req.user!.organizationId).toBe('org1');
  });

  it('should IGNORE org header override for a non-sysadmin even when enabled', async () => {
    // The override is sysadmin-only — a normal user cannot impersonate another
    // tenant's org via x-org-id, regardless of the route enabling the option.
    const token = await userToken({ organizationId: 'org1' });
    const req = createMockReq({
      headers: {
        'authorization': `Bearer ${token}`,
        'x-org-id': 'override-org',
      },
    });
    const res = createMockRes();
    const next = jest.fn();

    const middleware = requireAuth({ allowOrgHeaderOverride: true });
    middleware(req, res, next);
    await settle();

    expect(next).toHaveBeenCalled();
    expect(req.user!.organizationId).toBe('org1');
  });

  it('should apply org header override for a sysadmin when enabled', async () => {
    const token = await userToken({ sub: 'admin1', role: 'owner', organizationId: 'org1', isSuperAdmin: true });
    const req = createMockReq({
      headers: {
        'authorization': `Bearer ${token}`,
        'x-org-id': 'override-org',
      },
    });
    const res = createMockRes();
    const next = jest.fn();

    const middleware = requireAuth({ allowOrgHeaderOverride: true });
    middleware(req, res, next);
    await settle();

    expect(next).toHaveBeenCalled();
    expect(req.user!.organizationId).toBe('override-org');
  });

  it('should NOT apply org header override when not enabled', async () => {
    const token = await userToken({ organizationId: 'org1' });
    const req = createMockReq({
      headers: {
        'authorization': `Bearer ${token}`,
        'x-org-id': 'override-org',
      },
    });
    const res = createMockRes();
    const next = jest.fn();

    requireAuth(req, res, next);
    await settle();

    expect(next).toHaveBeenCalled();
    expect(req.user!.organizationId).toBe('org1');
  });
});

// isSystemAdmin

describe('isSystemAdmin', () => {
  it('returns true only when isSuperAdmin is true', () => {
    const req = createMockReq();
    req.user = { role: 'member', organizationId: 'org-acme', isSuperAdmin: true } as any;
    expect(isSystemAdmin(req)).toBe(true);
  });

  it('returns true even with no active org context', () => {
    const req = createMockReq();
    req.user = { role: 'member', isSuperAdmin: true } as any;
    expect(isSystemAdmin(req)).toBe(true);
  });

  it('returns false when isSuperAdmin is missing (no req.user)', () => {
    const req = createMockReq();
    expect(isSystemAdmin(req)).toBe(false);
  });

  it('returns false when isSuperAdmin is explicitly false', () => {
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: 'org-acme', isSuperAdmin: false } as any;
    expect(isSystemAdmin(req)).toBe(false);
  });

  it('returns false for legacy admin in system org without isSuperAdmin flag', () => {
    // The legacy "membership in the system org grants sysadmin" branch is
    // removed — operators must be granted authority via the user-level flag.
    const req = createMockReq();
    req.user = { role: 'admin', organizationId: '000000000000000000000001' } as any;
    expect(isSystemAdmin(req)).toBe(false);
  });

  it('returns false for legacy owner in system org without isSuperAdmin flag', () => {
    const req = createMockReq();
    req.user = { role: 'owner', organizationId: '000000000000000000000001' } as any;
    expect(isSystemAdmin(req)).toBe(false);
  });
});

// signServiceToken / getServiceAuthHeader / isServicePrincipal
//
// Service tokens are minted by callers who can't forward a user JWT (cron,
// webhooks, queue workers). They must satisfy `requireAuth` end-to-end and
// be distinguishable from real user tokens via `isServicePrincipal`.

describe('signServiceToken', () => {
  /** Verify through the per-service chain, as a peer service would. */
  const verifyService = (token: string): JwtPayload => {
    const kid = (JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()) as { kid: string }).kid;
    return verifyServiceJwt<JwtPayload>(token, { kid });
  };

  it('mints an ES256 JWT verifiable with the signing service OWN key', () => {
    const token = serviceToken('billing', { orgId: '000000000000000000000001', role: 'owner' });
    const decoded = verifyService(token);
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).alg).toBe('ES256');
    expect(decoded.sub).toBe('service:billing');
    expect(decoded.username).toBe('billing-service');
    expect(decoded.organizationId).toBe('000000000000000000000001');
    expect(decoded.role).toBe('owner');
    expect(decoded.type).toBe('access');
    expect(decoded.isAdmin).toBe(true);
    // Gates branch on the claim, not on the `service:` subject shape.
    expect(decoded.principalType).toBe('service');
    expect(decoded.token_use).toBe('access');
  });

  it('accepts a custom orgName (defaults to orgId)', () => {
    const token = serviceToken('platform', { orgId: 'org-1', orgName: 'Acme', role: 'owner' });
    const decoded = verifyService(token);
    expect(decoded.organizationId).toBe('org-1');
    expect(decoded.organizationName).toBe('Acme');
  });

  it('defaults orgName to orgId when omitted', () => {
    const token = serviceToken('compliance', { orgId: '000000000000000000000001', role: 'owner' });
    const decoded = verifyService(token);
    expect(decoded.organizationName).toBe('000000000000000000000001');
  });

  it('expires within the configured TTL (default 5 min)', () => {
    const token = serviceToken('plugin', { role: 'owner' });
    const decoded = verifyService(token);
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
    const ttl = (decoded.exp as number) - (decoded.iat as number);
    expect(ttl).toBe(300); // default 5 min
  });

  it('honors custom ttlSeconds', () => {
    const token = serviceToken('plugin', { ttlSeconds: 60, role: 'owner' });
    const decoded = verifyService(token);
    const ttl = (decoded.exp as number) - (decoded.iat as number);
    expect(ttl).toBe(60);
  });

  it('produces tokens that satisfy requireAuth without modification', (done) => {
    const token = serviceToken('billing', { orgId: '000000000000000000000001', role: 'owner' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = createMockRes();
    requireAuth(req, res, () => {
      expect(req.user?.sub).toBe('service:billing');
      expect(req.user?.role).toBe('owner');
      done();
    });
  });

  it('refuses to mint a token for a service whose key this process does not hold', () => {
    serviceKeys.becomeService('billing');
    // The api/plugin -> `service:platform` pattern the shared secret allowed:
    // now an immediate, obvious error rather than a token no peer accepts.
    expect(() => signServiceToken({ serviceName: 'platform', role: 'owner' }))
      .toThrow(/cannot mint a token for 'platform'/);
  });

  it('refuses a token signed by ANOTHER service, whatever its subject claims', () => {
    const forged = serviceKeys.signAs('evil', 'billing');
    expect(() => verifyService(forged)).toThrow(/was signed by evil/);
  });
});

describe('getServiceAuthHeader', () => {
  it('returns "Bearer <jwt>" format', () => {
    serviceKeys.becomeService('billing');
    const header = getServiceAuthHeader({ serviceName: 'billing', orgId: '000000000000000000000001', role: 'owner' });
    expect(header).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const token = header.slice(7);
    expect((jwt.decode(token) as JwtPayload).sub).toBe('service:billing');
  });
});

describe('isServicePrincipal', () => {
  it('returns true for a service principalType', () => {
    const req = createMockReq();
    req.user = { sub: 'service:billing', role: 'owner', principalType: 'service', token_use: 'access' } as any;
    expect(isServicePrincipal(req)).toBe(true);
  });

  it('returns false for a regular user JWT', () => {
    const req = createMockReq();
    req.user = { sub: '64f0e0a1b2c3d4e5f6a7b8c9', role: 'admin' } as any;
    expect(isServicePrincipal(req)).toBe(false);
  });

  it('returns false when req.user is undefined', () => {
    const req = createMockReq();
    expect(isServicePrincipal(req)).toBe(false);
  });
});

// verifyServicePrincipal
//
// A PRE-auth check (runs before requireAuth populates req.user) that
// CRYPTOGRAPHICALLY verifies the bearer token is a valid, signed SERVICE
// token. Unlike isServicePrincipal (which trusts an already-verified
// req.user.sub), this must not be fooled by an unsigned/tampered token or a
// spoofable header, since it gates things like rate-limiter bypass.

describe('verifyServicePrincipal', () => {
  it('returns true for a token minted by signServiceToken', () => {
    const token = serviceToken('billing', { orgId: 'org1', role: 'member' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(verifyServicePrincipal(req)).toBe(true);
  });

  it('returns false for a normal user access token (principalType user)', () => {
    const token = signToken({ type: 'access', sub: 'user1', role: 'member', ...USER_CLAIMS });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(verifyServicePrincipal(req)).toBe(false);
  });

  it('returns false when the Authorization header is missing', () => {
    const req = createMockReq();
    expect(verifyServicePrincipal(req)).toBe(false);
  });

  it('returns false for a malformed Authorization header', () => {
    expect(verifyServicePrincipal(createMockReq({ headers: { authorization: 'Basic abc123' } }))).toBe(false);
    expect(verifyServicePrincipal(createMockReq({ headers: { authorization: 'Bearer' } }))).toBe(false);
    const token = serviceToken('billing', { orgId: 'org1', role: 'member' });
    // Extra segment → split length !== 2.
    expect(verifyServicePrincipal(createMockReq({ headers: { authorization: `Bearer ${token} extra` } }))).toBe(false);
  });

  it('returns false for an HS256 service token, whatever secret signed it', () => {
    const token = jwt.sign(
      { sub: 'service:evil', role: 'owner', type: 'access', principalType: 'service', token_use: 'access' },
      'wrong-secret',
      { expiresIn: 60 },
    );
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(verifyServicePrincipal(req)).toBe(false);
  });

  it('returns false for a token signed by a DIFFERENT service than its subject names', () => {
    const forged = serviceKeys.signAs('evil', 'billing');
    expect(verifyServicePrincipal(createMockReq({ headers: { authorization: `Bearer ${forged}` } }))).toBe(false);
  });

  it('returns false for a tampered token', () => {
    const token = serviceToken('billing', { orgId: 'org1', role: 'member' });
    // Mutate a BYTE of the decoded signature, not a character of its encoding.
    // An ES256 signature is 64 bytes → 86 base64url characters, and the final
    // character carries only 2 significant bits: flipping it can decode to the
    // very same 64 bytes, leaving the token valid (a ~1-in-64 flake this test
    // used to have). Round-tripping through the bytes cannot.
    const [header, payload, signature] = token.split('.');
    const bytes = Buffer.from(signature, 'base64url');
    bytes[0] = (bytes[0] + 1) % 256; // no-bitwise: a plain increment mutates the byte just as well
    const tampered = `${header}.${payload}.${bytes.toString('base64url')}`;
    const req = createMockReq({ headers: { authorization: `Bearer ${tampered}` } });
    expect(verifyServicePrincipal(req)).toBe(false);
  });

  it('returns false for a service-sub token that is NOT an access token', () => {
    // Correctly signed and service-scoped, but wrong token type → rejected.
    const token = signToken({ type: 'refresh', sub: 'service:billing', role: 'member' });
    const req = createMockReq({ headers: { authorization: `Bearer ${token}` } });
    expect(verifyServicePrincipal(req)).toBe(false);
  });
});

// Authorization-denial auditor (#5 — failed/denied attempt logging)

describe('setAuthzDenialAuditor', () => {
  function denialReq(overrides: Partial<Request> = {}): Request {
    return {
      headers: {},
      method: 'POST',
      originalUrl: '/pipelines/pl-1',
      user: { sub: 'u1', email: 'u1@example.com', organizationId: 'org-1', permissions: [] },
      ...overrides,
    } as unknown as Request;
  }

  afterEach(() => setAuthzDenialAuditor(undefined));

  it('fires on a requirePermission denial for a non-GET request with the required permission', () => {
    const seen: AuthzDenialInfo[] = [];
    setAuthzDenialAuditor((i) => seen.push(i));
    const res = createMockRes();
    requirePermission('pipelines:write')(denialReq(), res, jest.fn());
    expect(res._status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      actorId: 'u1',
      orgId: 'org-1',
      method: 'POST',
      path: '/pipelines/pl-1',
      required: 'pipelines:write',
    });
  });

  it('does NOT fire for a denied GET (low-signal probing noise)', () => {
    const fn = jest.fn();
    setAuthzDenialAuditor(fn);
    const res = createMockRes();
    requirePermission('pipelines:write')(denialReq({ method: 'GET' }), res, jest.fn());
    expect(res._status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });

  it('does NOT fire when the permission is granted', () => {
    const fn = jest.fn();
    setAuthzDenialAuditor(fn);
    const res = createMockRes();
    const next = jest.fn();
    const req = denialReq({ user: { sub: 'u1', permissions: ['pipelines:write'] } as unknown as JwtPayload });
    requirePermission('pipelines:write')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires on a requireSystemAdmin denial with required=system-admin', () => {
    const seen: AuthzDenialInfo[] = [];
    setAuthzDenialAuditor((i) => seen.push(i));
    const res = createMockRes();
    requireSystemAdmin(denialReq(), res, jest.fn());
    expect(res._status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0].required).toBe('system-admin');
  });

  it('is best-effort: a throwing auditor does not break the gate', () => {
    setAuthzDenialAuditor(() => { throw new Error('audit sink down'); });
    const res = createMockRes();
    expect(() => requirePermission('pipelines:write')(denialReq(), res, jest.fn())).not.toThrow();
    expect(res._status).toBe(403);
  });

  it('does nothing when no auditor is registered', () => {
    const res = createMockRes();
    expect(() => requirePermission('pipelines:write')(denialReq(), res, jest.fn())).not.toThrow();
    expect(res._status).toBe(403);
  });
});

// Session-invalidation: token-revocation store (#1 option (b))

describe('setTokenRevocationStore + requireAuth revocation check', () => {
  afterEach(() => setTokenRevocationStore(undefined));

  async function authReq(tokenVersion?: number) {
    const token = await userToken({ sub: 'user-x', organizationId: 'org1', tokenVersion });
    return createMockReq({ headers: { authorization: `Bearer ${token}` } });
  }

  // Resolve once requireAuth reaches a terminal state (next() or a sent error).
  function runAuth(req: Request) {
    return new Promise<{ status: number; passed: boolean }>((resolve) => {
      const res = createMockRes();
      const origJson = res.json.bind(res);
      (res as any).json = (b: unknown) => { const r = origJson(b); resolve({ status: res._status, passed: false }); return r; };
      requireAuth(req, res, () => resolve({ status: 0, passed: true }));
    });
  }

  it('rejects a token whose tokenVersion is behind the store (revoked) with 401 TOKEN_REVOKED', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 5 });
    const out = await runAuth(await authReq(3));
    expect(out.passed).toBe(false);
    expect(out.status).toBe(401);
  });

  it('allows a token whose tokenVersion matches the store', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 4 });
    expect((await runAuth(await authReq(4))).passed).toBe(true);
  });

  it('allows on a store miss (null → no known revocation, fail-open)', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => null });
    expect((await runAuth(await authReq(2))).passed).toBe(true);
  });

  it('allows when the store throws (fail-open, no lockout on Redis outage)', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => { throw new Error('redis down'); } });
    expect((await runAuth(await authReq(2))).passed).toBe(true);
  });

  it('does no revocation check when no store is registered (backward compatible)', async () => {
    expect((await runAuth(await authReq(1))).passed).toBe(true);
  });

  it('skips the check for a token with no tokenVersion (e.g. service tokens)', async () => {
    const store = { getCurrentVersion: jest.fn(async () => 9) };
    setTokenRevocationStore(store);
    expect((await runAuth(await authReq(undefined))).passed).toBe(true);
    expect(store.getCurrentVersion).not.toHaveBeenCalled();
  });
});

describe('requireAuth — impersonation session revocation (cross-service)', () => {
  afterEach(() => setTokenRevocationStore(undefined));

  async function tokenReq(claims: Record<string, unknown>) {
    const token = await userToken({ sub: 'target', organizationId: 'org1', tokenVersion: 1, ...claims });
    return createMockReq({ headers: { authorization: `Bearer ${token}` } });
  }
  const impersonation = () => tokenReq({ impersonatorId: 'sysadmin', impersonationReadOnly: true, jti: 'sess-1' });

  function runAuth(req: Request) {
    return new Promise<{ status: number; passed: boolean }>((resolve) => {
      const res = createMockRes();
      const origJson = res.json.bind(res);
      (res as any).json = (b: unknown) => { const r = origJson(b); resolve({ status: res._status, passed: false }); return r; };
      requireAuth(req, res, () => resolve({ status: 0, passed: true }));
    });
  }

  it('allows a live session', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 1, getSessionRevocation: async () => 'live' });
    expect((await runAuth(await impersonation())).passed).toBe(true);
  });

  it('REJECTS a session that was ended — the point of cross-service revocation', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 1, getSessionRevocation: async () => 'revoked' });
    const out = await runAuth(await impersonation());
    expect(out).toEqual({ status: 401, passed: false });
  });

  it('REJECTS when the store cannot answer — an outage must not read as "not revoked"', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 1, getSessionRevocation: async () => 'unavailable' });
    expect((await runAuth(await impersonation())).passed).toBe(false);
  });

  it('REJECTS when the store throws', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 1, getSessionRevocation: async () => { throw new Error('redis down'); } });
    expect((await runAuth(await impersonation())).passed).toBe(false);
  });

  it('REJECTS when NO store is registered — unlike ordinary sessions, which pass', async () => {
    // For an ordinary token, no store means no check. For an impersonation
    // session that would silently mean "can never be revoked".
    expect((await runAuth(await impersonation())).passed).toBe(false);
    expect((await runAuth(await tokenReq({}))).passed).toBe(true);
  });

  it('REJECTS when the registered store predates session revocation', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 1 });
    expect((await runAuth(await impersonation())).passed).toBe(false);
  });

  it('still applies the tokenVersion check to a live session', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 7, getSessionRevocation: async () => 'live' });
    expect((await runAuth(await impersonation())).passed).toBe(false);
  });

  it('does not treat a Personal Access Token (token_use api_key, no impersonatorId) as a session', async () => {
    const store = { getCurrentVersion: async () => 1, getSessionRevocation: jest.fn(async () => 'revoked' as const) };
    setTokenRevocationStore(store);
    expect((await runAuth(await tokenReq({ jti: 'pat-1', token_use: 'api_key' }))).passed).toBe(true);
    expect(store.getSessionRevocation).not.toHaveBeenCalled();
  });

  it('leaves ordinary sessions fail-open on a store outage', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => { throw new Error('down'); }, getSessionRevocation: async () => 'unavailable' });
    expect((await runAuth(await tokenReq({}))).passed).toBe(true);
  });
});

describe('isAccessTokenRevoked — impersonation sessions (out-of-band mint paths)', () => {
  afterEach(() => setTokenRevocationStore(undefined));

  it('reports an ended session as revoked', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 1, getSessionRevocation: async () => 'revoked' });
    await expect(isAccessTokenRevoked({ sub: 't', tokenVersion: 1, jti: 's', impersonatorId: 'op' })).resolves.toBe(true);
  });

  it('reports an unverifiable session as revoked, so it cannot mint registry tokens', async () => {
    await expect(isAccessTokenRevoked({ sub: 't', tokenVersion: 1, jti: 's', impersonatorId: 'op' })).resolves.toBe(true);
  });

  it('reports a live session as not revoked', async () => {
    setTokenRevocationStore({ getCurrentVersion: async () => 1, getSessionRevocation: async () => 'live' });
    await expect(isAccessTokenRevoked({ sub: 't', tokenVersion: 1, jti: 's', impersonatorId: 'op' })).resolves.toBe(false);
  });
});

// requireAllPermissions (AND semantics)

describe('requireAllPermissions', () => {
  afterEach(() => setAuthzDenialAuditor(undefined));

  function req(permissions: string[], isSuperAdmin = false) {
    return { method: 'POST', originalUrl: '/x', user: { sub: 'u', permissions, isSuperAdmin } } as unknown as Request;
  }

  it('passes when the user holds every required permission', () => {
    const res = createMockRes(); const next = jest.fn();
    requireAllPermissions('pipelines:read', 'pipelines:write')(req(['pipelines:read', 'pipelines:write']), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('403s when any one is missing (and lists only the missing one)', () => {
    const res = createMockRes(); const next = jest.fn();
    requireAllPermissions('pipelines:read', 'pipelines:write')(req(['pipelines:read']), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(JSON.stringify(res._json)).toContain('pipelines:write');
  });

  it('superadmin bypasses even with no explicit permissions', () => {
    const res = createMockRes(); const next = jest.fn();
    requireAllPermissions('pipelines:write', 'billing:manage')(req([], true), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('fires the denial auditor on a missing-permission rejection', () => {
    const seen: unknown[] = [];
    setAuthzDenialAuditor((i) => seen.push(i));
    requireAllPermissions('a:write' as any, 'b:write' as any)(req(['a:write']), createMockRes(), jest.fn());
    expect(seen).toHaveLength(1);
  });
});

// requireFeature — paid-entitlement gate (e.g. DORA's `advanced_reporting`)

describe('requireFeature', () => {
  function req(features?: string[], isSuperAdmin = false, authed = true) {
    return (authed
      ? { method: 'GET', originalUrl: '/reports/execution/dora', user: { sub: 'u', features, isSuperAdmin } }
      : { method: 'GET', originalUrl: '/reports/execution/dora' }) as unknown as Request;
  }

  it('passes when the user holds the feature', () => {
    const res = createMockRes(); const next = jest.fn();
    requireFeature('advanced_reporting')(req(['advanced_reporting']), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('403s when the feature is absent', () => {
    const res = createMockRes(); const next = jest.fn();
    requireFeature('advanced_reporting')(req(['custom_integrations']), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(JSON.stringify(res._json)).toContain('advanced_reporting');
  });

  it('403s when the token carries no features array', () => {
    const res = createMockRes(); const next = jest.fn();
    requireFeature('advanced_reporting')(req(undefined), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it('superadmin bypasses even without the feature', () => {
    const res = createMockRes(); const next = jest.fn();
    requireFeature('advanced_reporting')(req([], true), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('401s when unauthenticated (no req.user)', () => {
    const res = createMockRes(); const next = jest.fn();
    requireFeature('advanced_reporting')(req(undefined, false, false), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });

  it('routes a denial through the authz-denial auditor (state-changing method)', () => {
    const seen: AuthzDenialInfo[] = [];
    setAuthzDenialAuditor((i) => seen.push(i));
    const res = createMockRes(); const next = jest.fn();
    const postReq = { method: 'POST', originalUrl: '/reports/x', user: { sub: 'u', features: [] } } as unknown as Request;
    requireFeature('advanced_reporting')(postReq, res, next);
    expect(res._status).toBe(403);
    expect(seen).toHaveLength(1);
    expect(seen[0].required).toBe('feature:advanced_reporting');
    setAuthzDenialAuditor(undefined);
  });
});

// signServiceToken hardening

describe('signServiceToken jti', () => {
  it('mints a unique jti on every call', () => {
    const a = jwt.decode(serviceToken('billing', { orgId: 'o', role: 'member' })) as any;
    const b = jwt.decode(serviceToken('billing', { orgId: 'o', role: 'member' })) as any;
    expect(typeof a.jti).toBe('string');
    expect(a.jti).not.toBe(b.jti);
  });
});
