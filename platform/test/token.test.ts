// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock config and models before importing
import { jest, describe, it, expect } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import jwt from 'jsonwebtoken';
import { mockConfig } from './helpers/config-mock.js';
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  auth: {
    passwordMinLength: 8,
    jwt: {
      secret: 'test-jwt-secret',
      expiresIn: 7200,
      algorithm: 'HS256',
      saltRounds: 12,
    },
    refreshToken: {
      secret: 'test-refresh-secret',
      expiresIn: 2592000,
    },
  },
}));

// Chainable `find(...).session(...).select(...).lean()` that resolves to [] —
// rolePermissionsFor short-circuits on no assignments, so tokens resolve
// to the role's base permission bundle with no group grants in these tests.
const emptyFindChain = () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) });

const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>(() => ({ select: () => ({ lean: async () => null }) }));
const mockPublishSlot = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: (...a: unknown[]) => mockPublishSlot(...a),
}));

// Refresh-session slots live in their own collection behind session-store.ts.
const { sessionStoreFake } = await import('./helpers/session-store-fake.js');
const store = sessionStoreFake();
jest.unstable_mockModule('../src/services/session/session-store.js', () => store);

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  User: {
    updateOne: jest.fn<AnyFn>().mockResolvedValue({}),
    findById: (...a: unknown[]) => mockUserFindById(...a),
  },
  Organization: {},
  UserOrganization: {},
  Role: { find: jest.fn(emptyFindChain) },
  RoleAssignment: { find: jest.fn(emptyFindChain) },
}));

jest.unstable_mockModule('crypto', () => {
  const actual = jest.requireActual('crypto') as typeof import('crypto');
  const mocked = {
    ...actual,
    randomBytes: jest.fn(actual.randomBytes),
  };
  // token.js does `import crypto from 'crypto'` (default import), so the ESM
  // mock must expose a `default` namespace alongside the named exports.
  return { ...mocked, default: mocked };
});

const { signInAuth } = await import('../src/services/session/access-tokens.js');
const { MAX_REFRESH_SESSIONS, MAX_MACHINE_SESSIONS, hashRefreshToken, issueTokens } = await import('../src/services/session/refresh-sessions.js');
const { verifyAccessToken, verifyRefreshToken } = await import('../src/utils/token.js');

// Platform is the only minter of user tokens, so the real token module needs a
// loaded ES256 signing key. Generated in memory — no PEM on disk, no KMS.
const { installTestSigningKeys } = await import('./helpers/signing.js');
installTestSigningKeys();

/** An interactive sign-in session, the common case in these tests. */
const login = (extra: Record<string, unknown> = {}) => ({ kind: 'interactive' as const, auth: signInAuth('pwd'), ...extra });

// Helpers
function mockUser(overrides: Partial<{
  _id: { toString(): string };
  username: string;
  email: string;
  isEmailVerified: boolean;
  lastActiveOrgId: { toString(): string } | string;
  tokenVersion: number;
  claimsVersion: number;
}> = {}) {
  return {
    _id: overrides._id || { toString: () => 'user-123' },
    username: overrides.username || 'testuser',
    email: overrides.email || 'test@example.com',
    isEmailVerified: overrides.isEmailVerified ?? true,
    lastActiveOrgId: 'lastActiveOrgId' in overrides ? overrides.lastActiveOrgId : { toString: () => 'org-456' },
    tokenVersion: overrides.tokenVersion ?? 1,
    ...(overrides.claimsVersion !== undefined ? { claimsVersion: overrides.claimsVersion } : {}),
  } as any;
}

// Tests

describe('token utilities', () => {
  describe('hashRefreshToken', () => {
    it('should return a hex SHA-256 hash', () => {
      const hash = hashRefreshToken('my-refresh-token');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce consistent hashes', () => {
      const hash1 = hashRefreshToken('token-value');
      const hash2 = hashRefreshToken('token-value');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', () => {
      const hash1 = hashRefreshToken('token-a');
      const hash2 = hashRefreshToken('token-b');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyAccessToken', () => {
    it('should verify a valid access token', async () => {
      const { accessToken } = await issueTokens(mockUser(), undefined, login());
      const payload = verifyAccessToken(accessToken);

      expect(payload.type).toBe('access');
      expect(payload.sub).toBe('user-123');
    });

    it('should throw for an invalid token', () => {
      expect(() => verifyAccessToken('invalid.token.here')).toThrow();
    });

    it('should throw for a token signed with wrong secret', () => {
      const token = jwt.sign({ type: 'access', sub: '123' }, 'wrong-secret');
      expect(() => verifyAccessToken(token)).toThrow();
    });
  });

  describe('verifyRefreshToken', () => {
    it('should verify a valid refresh token', async () => {
      const { refreshToken } = await issueTokens(mockUser(), undefined, login());
      const payload = verifyRefreshToken(refreshToken);

      expect(payload.type).toBe('refresh');
      expect(payload.sub).toBe('user-123');
    });

    it('should throw for invalid token', () => {
      expect(() => verifyRefreshToken('bad-token')).toThrow();
    });
  });

  describe('issueTokens', () => {
    it('opens a new refresh-session slot (capped) and records token history', async () => {
      const { User } = await import('../src/models/index.js') as unknown as { User: { updateOne: jest.Mock } };
      const user = mockUser();

      const result = await issueTokens(user, undefined, login());

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      const sid = (jwt.decode(result.refreshToken) as { sid: string }).sid;
      expect((jwt.decode(result.accessToken) as { sid: string }).sid).toBe(sid);
      // The slot is its own row (refresh_sessions), opened under its kind's cap
      // (a sign-in can never evict a stored machine credential).
      const [userId, added, cap] = store.insertSlot.mock.calls.at(-1)! as unknown as [unknown, Record<string, unknown>, number];
      expect(userId).toBe(user._id);
      expect(cap).toBe(MAX_REFRESH_SESSIONS);
      expect(added).toMatchObject({
        id: sid,
        kind: 'interactive',
        tokenVersion: 1,
        hash: hashRefreshToken(result.refreshToken),
        amr: ['pwd'],
        aal: 1,
        purgeAt: expect.any(Date),
      });
      // The token history stays on the user document, ring-buffered to 20.
      const [filter, update] = User.updateOne.mock.calls.at(-1)! as unknown as [unknown, any];
      expect(filter).toEqual({ _id: user._id });
      expect(update.$push.issuedTokens.$slice).toBe(-20);
      expect(update.$push.issuedTokens.$each[0]).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f]{16}$/),
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
        tokenVersionAtIssue: 1,
      });
    });

    it('the ACCESS token carries tokenVersion + claimsVersion; the REFRESH token only the hard tokenVersion', async () => {
      const { accessToken, refreshToken } = await issueTokens(mockUser({ tokenVersion: 2, claimsVersion: 5 }), undefined, login());
      expect((jwt.decode(accessToken) as { tokenVersion: number }).tokenVersion).toBe(7);
      expect((jwt.decode(refreshToken) as { tokenVersion: number }).tokenVersion).toBe(2);
    });

    it('records the token version at time of issuance', async () => {
      const { User } = await import('../src/models/index.js') as unknown as { User: { updateOne: jest.Mock } };
      const user = mockUser({ tokenVersion: 7 });
      await issueTokens(user, undefined, login());
      const update = User.updateOne.mock.calls.at(-1)?.[1] as any;
      expect(update.$push.issuedTokens.$each[0].tokenVersionAtIssue).toBe(7);
      expect((store.insertSlot.mock.calls.at(-1)?.[1] as any).tokenVersion).toBe(7);
    });

    it('records expiresAt aligned to the access token\'s exp claim', async () => {
      const { User } = await import('../src/models/index.js') as unknown as { User: { updateOne: jest.Mock } };
      const before = Date.now();
      await issueTokens(mockUser(), undefined, login());
      const update = User.updateOne.mock.calls.at(-1)?.[1] as any;
      const recordedExpiresMs = (update.$push.issuedTokens.$each[0].expiresAt as Date).getTime();
      // Within 2 seconds of expected window (test execution jitter).
      expect(Math.abs(recordedExpiresMs - (before + 7200 * 1000))).toBeLessThan(2000);
    });

    it('should default access-token expiresIn to config value when override is omitted', async () => {
      const { accessToken, expiresIn } = await issueTokens(mockUser(), undefined, login());
      expect(expiresIn).toBe(7200); // matches mocked config.auth.jwt.expiresIn
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(7200);
    });

    // A machine credential's lifetime is its SLOT's; its ACCESS tokens never
    // outlive a person's (so a revocation entry sized to that lifetime can never
    // lapse under a live token), and are renewed through the slot's refresh token.
    it.each([
      ['30 days', 30 * 24 * 60 * 60],
      ['90 days', 90 * 24 * 60 * 60],
      ['365 days (CLI cap)', 365 * 24 * 60 * 60],
    ])('caps a %s machine credential\'s access token at the normal lifetime; the slot + refresh token carry the lifetime', async (_label, lifetime) => {
      const before = Date.now();
      const { accessToken, refreshToken, expiresIn } = await issueTokens(mockUser(), undefined, { kind: 'machine', auth: signInAuth('pwd'), lifetimeSeconds: lifetime });
      expect(expiresIn).toBe(7200);
      const access = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(access.exp - access.iat).toBe(7200);
      const refresh = jwt.decode(refreshToken) as { exp: number; iat: number };
      expect(Math.abs(refresh.exp - refresh.iat - lifetime)).toBeLessThanOrEqual(1);
      const added = store.insertSlot.mock.calls.at(-1)?.[1] as any;
      expect(Math.abs((added.expiresAt as Date).getTime() - (before + lifetime * 1000))).toBeLessThan(2000);
      expect(store.insertSlot.mock.calls.at(-1)?.[2]).toBe(MAX_MACHINE_SESSIONS);
    });

    it('never mints an access token past a SHORT machine credential\'s end (1 hour)', async () => {
      const { accessToken, refreshToken } = await issueTokens(mockUser(), undefined, { kind: 'machine', auth: signInAuth('pwd'), lifetimeSeconds: 3600 });
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(Math.abs(decoded.exp - decoded.iat - 3600)).toBeLessThanOrEqual(1);
      const refresh = jwt.decode(refreshToken) as { exp: number; iat: number };
      expect(Math.abs(refresh.exp - refresh.iat - 3600)).toBeLessThanOrEqual(1);
    });

    it('an interactive session\'s refresh token keeps the configured refresh lifetime', async () => {
      const { refreshToken } = await issueTokens(mockUser(), undefined, login());
      const refresh = jwt.decode(refreshToken) as { exp: number; iat: number };
      // The refresh TTL (30d) — here equal to the platform maximum session age,
      // which also caps it (so it can land a second short).
      expect(refresh.exp - refresh.iat).toBeGreaterThanOrEqual(2592000 - 1);
      expect(refresh.exp - refresh.iat).toBeLessThanOrEqual(2592000);
    });

    it('caps an interactive session\'s refresh token at its maximum age from sign-in', async () => {
      // Signed in 29 days ago (e.g. the survivor of "sign out everywhere"): one day left.
      const auth = { ...signInAuth('pwd'), authTime: new Date(Date.now() - 29 * 86400_000) };
      const { refreshToken } = await issueTokens(mockUser(), undefined, { kind: 'interactive', auth });
      const refresh = jwt.decode(refreshToken) as { exp: number; iat: number };
      expect(Math.abs(refresh.exp - refresh.iat - 86400)).toBeLessThanOrEqual(2);
    });

    it('refuses to open an interactive slot for a sign-in already past the maximum age (SESSION_EXPIRED)', async () => {
      const auth = { ...signInAuth('pwd'), authTime: new Date(Date.now() - 31 * 86400_000) };
      await expect(issueTokens(mockUser(), undefined, { kind: 'interactive', auth })).rejects.toThrow('SESSION_EXPIRED');
    });

    it('machine slots are not bound by the interactive maximum age', async () => {
      const auth = { ...signInAuth('pwd'), authTime: new Date(Date.now() - 365 * 86400_000) };
      await expect(issueTokens(mockUser(), undefined, { kind: 'machine', auth, lifetimeSeconds: 3600 })).resolves.toBeDefined();
    });
  });

  describe('scoped machine token', () => {
    it('mints a least-privilege reporting:ingest token — even from a super-admin operator', async () => {
      // CRITICAL: a scoped token minted by a super-admin must NOT inherit sysadmin.
      const user = { ...mockUser(), isSuperAdmin: true } as any;
      const { accessToken } = await issueTokens(user, undefined, { kind: 'machine', auth: signInAuth('pwd'), lifetimeSeconds: 3600, scope: 'reporting:ingest' });
      const decoded = jwt.decode(accessToken) as any;
      expect(decoded.scope).toBe('reporting:ingest');
      expect(decoded.role).toBe('member');
      expect(decoded.isAdmin).toBe(false);
      expect(decoded.isSuperAdmin).toBeUndefined();
      expect(decoded.features).toEqual([]);
    });

    it('omits the scope claim on a normal (interactive) token', async () => {
      const { accessToken } = await issueTokens(mockUser(), undefined, login());
      const decoded = jwt.decode(accessToken) as any;
      expect(decoded.scope).toBeUndefined();
    });
  });

  describe('identity claims', () => {
    it('stamps principalType / token_use / amr / aal / auth_time on a session token', async () => {
      const auth = signInAuth('sso');
      const { accessToken } = await issueTokens(mockUser(), undefined, { kind: 'interactive', auth });
      const decoded = jwt.decode(accessToken) as any;
      expect(decoded.principalType).toBe('user');
      expect(decoded.token_use).toBe('access');
      expect(decoded.amr).toEqual(['sso']);
      expect(decoded.aal).toBe(1);
      expect(decoded.auth_time).toBe(Math.floor(auth.authTime.getTime() / 1000));
    });

    it('opens a machine slot under its own cap, evicting the least recently used', async () => {
      store.reset();
      const user = mockUser();
      // A full machine cap, oldest use first, plus an interactive slot that must survive.
      const t0 = Date.now() - 1_000_000;
      for (let i = 0; i < MAX_MACHINE_SESSIONS; i += 1) {
        store.rows.push({ userId: 'user-123', id: `m${i}`, kind: 'machine', lastUsedAt: new Date(t0 + i * 1000), createdAt: new Date(t0) });
      }
      store.rows.push({ userId: 'user-123', id: 'laptop', kind: 'interactive', lastUsedAt: new Date(t0), createdAt: new Date(t0) });
      await issueTokens(user, undefined, { kind: 'machine', auth: signInAuth('pwd') });
      const ids = store.rows.map((r) => r.id);
      // The least recently used machine slot went; the device session did not.
      expect(ids).not.toContain('m0');
      expect(ids).toContain('laptop');
      expect(store.rows.filter((r) => r.kind === 'machine')).toHaveLength(MAX_MACHINE_SESSIONS);
      expect(mockPublishSlot).toHaveBeenCalledWith(['m0']);
    });
  });
});

describe('slot eviction', () => {
  it('publishes revoke:sid for a slot the per-kind cap pushed out — its live token dies everywhere', async () => {
    mockPublishSlot.mockClear();
    store.insertSlot.mockResolvedValueOnce(['oldest']);
    await issueTokens(mockUser(), undefined, login());
    expect(mockPublishSlot).toHaveBeenCalledWith(['oldest']);
  });

  it('publishes nothing when the cap evicted nothing', async () => {
    mockPublishSlot.mockClear();
    store.insertSlot.mockResolvedValueOnce([]);
    await issueTokens(mockUser(), undefined, login());
    expect(mockPublishSlot).not.toHaveBeenCalled();
  });
});
