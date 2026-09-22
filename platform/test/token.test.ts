// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Mock config and models before importing
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect } from '@jest/globals';
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

const mockUserFindById = jest.fn<(...a: unknown[]) => unknown>(() => ({ select: () => ({ lean: async () => null }) }));
const mockPublishSlot = jest.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
jest.unstable_mockModule('../src/helpers/session-revocation.js', () => ({
  publishSessionSlotRevocation: (...a: unknown[]) => mockPublishSlot(...a),
}));

jest.unstable_mockModule('../src/models/index.js', () => ({
  // Linking stubs: user-profile/auth SUTs import these from the models barrel.
  PersonalAccessToken: {},
  UserPreferences: {},
  User: {
    updateOne: jest.fn<AnyFn>().mockResolvedValue({}),
    // The slot ids before/after the write (eviction publishing). Default:
    // unreadable, so nothing is published.
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

    it('the ACCESS token carries tokenVersion + claimsVersion; the REFRESH token only the hard tokenVersion', async () => {
      const { accessToken, refreshToken } = await issueTokens(mockUser({ tokenVersion: 2, claimsVersion: 5 }), undefined, login());
      expect((jwt.decode(accessToken) as { tokenVersion: number }).tokenVersion).toBe(7);
      expect((jwt.decode(refreshToken) as { tokenVersion: number }).tokenVersion).toBe(2);
    });

    it('records the token version at time of issuance', async () => {
      const { User } = await import('../src/models/index.js') as unknown as { User: { updateOne: jest.Mock } };
      const user = mockUser({ tokenVersion: 7 });
      await issueTokens(user, undefined, login());
      const set = (User.updateOne.mock.calls.at(-1)?.[1] as any)[0].$set;
      expect(set.issuedTokens.$slice[0].$concatArrays[1][0].$literal.tokenVersionAtIssue).toBe(7);
    });

    it('records expiresAt aligned to the access token\'s exp claim', async () => {
      const { User } = await import('../src/models/index.js') as unknown as { User: { updateOne: jest.Mock } };
      const before = Date.now();
      await issueTokens(mockUser(), undefined, login());
      const set = (User.updateOne.mock.calls.at(-1)?.[1] as any)[0].$set;
      const recordedExpiresMs = (set.issuedTokens.$slice[0].$concatArrays[1][0].$literal.expiresAt as Date).getTime();
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
      const { User } = await import('../src/models/index.js') as unknown as { User: { updateOne: jest.Mock } };
      const before = Date.now();
      const { accessToken, refreshToken, expiresIn } = await issueTokens(mockUser(), undefined, { kind: 'machine', auth: signInAuth('pwd'), lifetimeSeconds: lifetime });
      expect(expiresIn).toBe(7200);
      const access = jwt.decode(accessToken) as { exp: number; iat: number };
      expect(access.exp - access.iat).toBe(7200);
      const refresh = jwt.decode(refreshToken) as { exp: number; iat: number };
      expect(Math.abs(refresh.exp - refresh.iat - lifetime)).toBeLessThanOrEqual(1);
      const set = (User.updateOne.mock.calls.at(-1)?.[1] as any)[0].$set;
      const added = set.refreshSessions.$concatArrays[1].$concatArrays[1][0].$literal;
      expect(Math.abs((added.expiresAt as Date).getTime() - (before + lifetime * 1000))).toBeLessThan(2000);
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
      expect(refresh.exp - refresh.iat).toBe(2592000);
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

describe('slot eviction', () => {
  it('publishes revoke:sid for a slot the per-kind cap pushed out — its live token dies everywhere', async () => {
    const slots = (ids: string[]) => ({ select: () => ({ lean: async () => ({ refreshSessions: ids.map((id) => ({ id })) }) }) });
    mockUserFindById
      .mockReturnValueOnce(slots(['oldest', 'kept'])) // before the write
      .mockReturnValueOnce(slots(['kept', 'new-slot'])); // after it
    await issueTokens(mockUser(), undefined, login());
    expect(mockPublishSlot).toHaveBeenCalledWith(['oldest']);
  });

  it('publishes nothing when the after-state cannot be read (never "all evicted")', async () => {
    mockPublishSlot.mockClear();
    const slots = (ids: string[]) => ({ select: () => ({ lean: async () => ({ refreshSessions: ids.map((id) => ({ id })) }) }) });
    mockUserFindById
      .mockReturnValueOnce(slots(['a', 'b']))
      .mockReturnValueOnce({ select: () => ({ lean: async () => { throw new Error('down'); } }) });
    await issueTokens(mockUser(), undefined, login());
    expect(mockPublishSlot).not.toHaveBeenCalled();
  });
});
