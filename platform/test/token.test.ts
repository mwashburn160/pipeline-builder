// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock config and models before importing
import { jest, describe, it, expect, test } from '@jest/globals';
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
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
  },
}));

// Chainable `find(...).session(...).select(...).lean()` that resolves to [] —
// getUserRolePermissions short-circuits on no assignments, so tokens resolve
// to the role's base permission bundle with no group grants in these tests.
const emptyFindChain = () => ({ session: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) });

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  User: {
    updateOne: jest.fn().mockResolvedValue({}),
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

import jwt from 'jsonwebtoken';
const {
  MAX_REFRESH_SESSIONS,
  MAX_MACHINE_SESSIONS,
  hashRefreshToken,
  issueTokens,
  signInAuth,
  verifyAccessToken,
  verifyRefreshToken,
} = await import('../src/utils/token.js');

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
}> = {}) {
  return {
    _id: overrides._id || { toString: () => 'user-123' },
    username: overrides.username || 'testuser',
    email: overrides.email || 'test@example.com',
    isEmailVerified: overrides.isEmailVerified ?? true,
    lastActiveOrgId: 'lastActiveOrgId' in overrides ? overrides.lastActiveOrgId : { toString: () => 'org-456' },
    tokenVersion: overrides.tokenVersion ?? 1,
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
      // The slot is added through an aggregation pipeline so each KIND gets its
      // own cap (a sign-in can never evict a stored machine credential).
      const [filter, pipeline, options] = User.updateOne.mock.calls.at(-1)! as unknown as [unknown, Array<{ $set: Record<string, any> }>, unknown];
      expect(filter).toEqual({ _id: user._id });
      expect(options).toEqual({ updatePipeline: true });
      const set = pipeline[0].$set;
      expect(set.refreshSessions.$concatArrays[1].$slice[1]).toBe(-MAX_REFRESH_SESSIONS);
      const added = set.refreshSessions.$concatArrays[1].$slice[0].$concatArrays[1][0].$literal;
      expect(added).toMatchObject({
        id: sid,
        kind: 'interactive',
        hash: hashRefreshToken(result.refreshToken),
        amr: ['pwd'],
        aal: 1,
      });
      expect(set.issuedTokens.$slice[1]).toBe(-20);
      expect(set.issuedTokens.$slice[0].$concatArrays[1][0].$literal).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f]{16}$/),
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
        tokenVersionAtIssue: 1,
      });
    });

    it('records the token version at time of issuance', async () => {
      const { User } = await import('../src/models/index.js') as unknown as { User: { updateOne: jest.Mock } };
      const user = mockUser({ tokenVersion: 7 });
      await issueTokens(user, undefined, login());
      const set = (User.updateOne.mock.calls.at(-1)?.[1] as any)[0].$set;
      expect(set.issuedTokens.$slice[0].$concatArrays[1][0].$literal.tokenVersionAtIssue).toBe(7);
    });

    it('records expiresAt aligned to the JWT exp claim', async () => {
      const { User } = await import('../src/models/index.js') as unknown as { User: { updateOne: jest.Mock } };
      const before = Date.now();
      await issueTokens(mockUser(), undefined, login({ expiresIn: 600 }));
      const set = (User.updateOne.mock.calls.at(-1)?.[1] as any)[0].$set;
      const recordedExpiresMs = (set.issuedTokens.$slice[0].$concatArrays[1][0].$literal.expiresAt as Date).getTime();
      // Within 2 seconds of expected window (test execution jitter).
      expect(Math.abs(recordedExpiresMs - (before + 600 * 1000))).toBeLessThan(2000);
    });

    it('should default access-token expiresIn to config value when override is omitted', async () => {
      const { accessToken, expiresIn } = await issueTokens(mockUser(), undefined, login());
      expect(expiresIn).toBe(7200); // matches mocked config.auth.jwt.expiresIn
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(7200);
    });

    it('should honor a custom expiresIn override (regression: --days 30 from store-token CLI)', async () => {
      const THIRTY_DAYS_SEC = 30 * 24 * 60 * 60;
      const { accessToken, expiresIn } = await issueTokens(mockUser(), undefined, login({ expiresIn: THIRTY_DAYS_SEC }));
      expect(expiresIn).toBe(THIRTY_DAYS_SEC);
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(THIRTY_DAYS_SEC);
    });

    it('should honor a 90-day expiresIn override', async () => {
      const NINETY_DAYS_SEC = 90 * 24 * 60 * 60;
      const { accessToken, expiresIn } = await issueTokens(mockUser(), undefined, login({ expiresIn: NINETY_DAYS_SEC }));
      expect(expiresIn).toBe(NINETY_DAYS_SEC);
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(NINETY_DAYS_SEC);
    });

    it('should honor a 365-day expiresIn override (CLI cap)', async () => {
      const ONE_YEAR_SEC = 365 * 24 * 60 * 60;
      const { accessToken, expiresIn } = await issueTokens(mockUser(), undefined, login({ expiresIn: ONE_YEAR_SEC }));
      expect(expiresIn).toBe(ONE_YEAR_SEC);
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(ONE_YEAR_SEC);
    });

    it('should accept short custom expiresIn (e.g. 1 hour)', async () => {
      const { accessToken } = await issueTokens(mockUser(), undefined, login({ expiresIn: 3600 }));
      const decoded = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(decoded.exp - decoded.iat).toBe(3600);
    });
  });

  describe('scoped machine token', () => {
    it('mints a least-privilege reporting:ingest token — even from a super-admin operator', async () => {
      // CRITICAL: a scoped token minted by a super-admin must NOT inherit sysadmin.
      const user = { ...mockUser(), isSuperAdmin: true } as any;
      const { accessToken } = await issueTokens(user, undefined, { kind: 'machine', auth: signInAuth('pwd'), expiresIn: 3600, scope: 'reporting:ingest' });
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

  describe('identity claims (#7)', () => {
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
      const { User } = await import('../src/models/index.js') as unknown as { User: { updateOne: jest.Mock } };
      await issueTokens(mockUser(), undefined, { kind: 'machine', auth: signInAuth('pwd') });
      const set = (User.updateOne.mock.calls.at(-1)?.[1] as any)[0].$set;
      const kept = set.refreshSessions.$concatArrays[1].$concatArrays[0];
      // Machine slots are sorted by lastUsedAt and trimmed to cap-1, then the new
      // slot is appended — so a credential renewed daily is never the one dropped.
      expect(kept.$slice[1]).toBe(MAX_MACHINE_SESSIONS - 1);
      expect(kept.$slice[0].$sortArray.sortBy).toEqual({ lastUsedAt: -1 });
      expect(set.refreshSessions.$concatArrays[1].$concatArrays[1][0].$literal.kind).toBe('machine');
      // Interactive slots pass through untouched.
      expect(set.refreshSessions.$concatArrays[0].$filter.cond).toEqual({ $ne: ['$$this.kind', 'machine'] });
    });
  });
});
