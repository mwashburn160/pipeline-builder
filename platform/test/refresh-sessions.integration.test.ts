// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for per-device refresh-session slots: the positional,
 * hash-matched rotation can only be proven against a real server.
 *
 * Drives the REAL `isValidRefreshToken` middleware + `refresh` / `logout`
 * controllers end to end:
 *   - each sign-in opens its own slot; the oldest is evicted past the cap;
 *   - refresh rotates only its own slot;
 *   - reusing an already-rotated token revokes THAT slot, not the others;
 *   - logout clears only the current slot; a tokenVersion bump kills them all;
 *   - a scoped slot keeps its scope through refresh and can never be re-minted
 *     unscoped or under another scope (no machine-token privilege escalation).
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * organization-id-storage.integration.test.ts.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.REFRESH_TOKEN_SECRET ||= 'test-only-refresh-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const RUN = process.env.RUN_MONGO_INTEGRATION === '1' || process.env.RUN_MONGO_INTEGRATION === 'true';
const suite = RUN ? describe : describe.skip;

suite('refresh-session slots (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mongoose: any, User: any, token: any, authMw: any, authCtl: any, jwt: any;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    ({ User } = await import('../src/models/index.js'));
    token = await import('../src/utils/token.js');
    authMw = await import('../src/middleware/auth.js');
    authCtl = await import('../src/controllers/auth.js');
    jwt = (await import('jsonwebtoken')).default;
  }, 120_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  let userId: string;
  beforeEach(async () => {
    await User.deleteMany({});
    const u = await User.create({ username: 'dev', email: 'dev@example.com', isEmailVerified: true });
    userId = String(u._id);
  });

  const loadUser = () => User.findById(userId).select('+tokenVersion +isSuperAdmin');
  const slots = async () => (await User.findById(userId).select('+refreshSessions').lean()).refreshSessions as Array<{ id: string; hash: string }>;
  const sidOf = (t: string) => (jwt.decode(t) as { sid: string }).sid;

  function res() {
    const r: any = { locals: {} };
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    return r;
  }

  /** POST /auth/refresh through the real middleware + controller. */
  async function refresh(refreshToken: string): Promise<{ status: number; body: any }> {
    const req: any = { body: { refreshToken }, headers: {} };
    const r = res();
    let passed = false;
    await authMw.isValidRefreshToken(req, r, () => { passed = true; });
    if (passed) await authCtl.refresh(req, r);
    return { status: r.status.mock.calls[0]?.[0], body: r.json.mock.calls[0]?.[0] };
  }

  it('opens one slot per sign-in and evicts the oldest past the cap', async () => {
    const issued = [];
    for (let i = 0; i < token.MAX_REFRESH_SESSIONS + 1; i += 1) issued.push(await token.issueTokens(await loadUser()));
    const ids = (await slots()).map((s) => s.id);
    expect(ids).toHaveLength(token.MAX_REFRESH_SESSIONS);
    expect(ids).not.toContain(sidOf(issued[0].refreshToken));
    expect(ids).toContain(sidOf(issued.at(-1).refreshToken));
    // The access token names the same slot as its refresh token.
    expect(sidOf(issued[1].accessToken)).toBe(sidOf(issued[1].refreshToken));
  });

  it('rotates only the refreshed slot', async () => {
    const a = await token.issueTokens(await loadUser());
    const b = await token.issueTokens(await loadUser());
    const before = await slots();

    const out = await refresh(a.refreshToken);
    expect(out.status).toBe(200);
    const rotated = out.body.data;
    expect(sidOf(rotated.refreshToken)).toBe(sidOf(a.refreshToken));

    const after = await slots();
    const slotA = (list: typeof after) => list.find((s) => s.id === sidOf(a.refreshToken))!;
    const slotB = (list: typeof after) => list.find((s) => s.id === sidOf(b.refreshToken))!;
    expect(slotA(after).hash).toBe(token.hashRefreshToken(rotated.refreshToken));
    expect(slotB(after).hash).toBe(slotB(before).hash);
    // The rotated-in token works; device B still works.
    expect((await refresh(rotated.refreshToken)).status).toBe(200);
    expect((await refresh(b.refreshToken)).status).toBe(200);
  });

  it('reuse of an already-rotated token revokes THAT slot only', async () => {
    const a = await token.issueTokens(await loadUser());
    const b = await token.issueTokens(await loadUser());
    const rotated = (await refresh(a.refreshToken)).body.data;

    const reuse = await refresh(a.refreshToken);
    expect(reuse.status).toBe(401);

    const ids = (await slots()).map((s) => s.id);
    expect(ids).not.toContain(sidOf(a.refreshToken));
    expect(ids).toContain(sidOf(b.refreshToken));
    // The thief's rotation victim is signed out on that device, B is not.
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
    expect((await refresh(b.refreshToken)).status).toBe(200);
    // Not a sign-out-everywhere: tokenVersion is untouched.
    expect((await loadUser()).tokenVersion).toBe(0);
  });

  it('logout clears only the current slot', async () => {
    const a = await token.issueTokens(await loadUser());
    const b = await token.issueTokens(await loadUser());
    const req: any = { user: token.verifyAccessToken(a.accessToken), headers: {}, body: {} };
    const r = res();
    await authCtl.logout(req, r);
    expect(r.status).toHaveBeenCalledWith(200);

    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await refresh(b.refreshToken)).status).toBe(200);
  });

  it('switch-org re-issues within the same slot; a removed slot is refused', async () => {
    const a = await token.issueTokens(await loadUser());
    const renewed = await token.renewSessionTokens(await loadUser(), undefined, { sessionId: sidOf(a.refreshToken) });
    expect(sidOf(renewed.refreshToken)).toBe(sidOf(a.refreshToken));
    expect(await slots()).toHaveLength(1);

    await User.updateOne({ _id: userId }, { $set: { refreshSessions: [] } });
    expect(await token.renewSessionTokens(await loadUser(), undefined, { sessionId: sidOf(a.refreshToken) })).toBeNull();
  });

  it('refreshing a SCOPED machine token keeps the scope (no escalation to full privileges)', async () => {
    const scoped = await token.issueTokens(await loadUser(), undefined, undefined, 'reporting:ingest');
    expect((jwt.decode(scoped.accessToken) as { scope?: string }).scope).toBe('reporting:ingest');

    const out = await refresh(scoped.refreshToken);
    expect(out.status).toBe(200);
    const renewed = jwt.decode(out.body.data.accessToken) as { scope?: string; permissions?: string[] };
    expect(renewed.scope).toBe('reporting:ingest');
    expect(renewed.permissions).toEqual([]);
  });

  it('a scoped slot cannot be re-minted under another scope or unscoped', async () => {
    const scoped = await token.issueTokens(await loadUser(), undefined, undefined, 'reporting:ingest');
    const sessionId = sidOf(scoped.refreshToken);

    // Omitting the scope keeps it …
    const kept = await token.renewSessionTokens(await loadUser(), undefined, { sessionId });
    expect((jwt.decode(kept.accessToken) as { scope?: string }).scope).toBe('reporting:ingest');
    // … and asking for a different one is refused.
    await expect(token.renewSessionTokens(await loadUser(), undefined, { sessionId }, { scope: 'other:scope' }))
      .rejects.toThrow('TOKEN_SCOPE_ESCALATION');
  });

  it('generate-token from a scoped caller cannot drop the scope', async () => {
    const scoped = await token.issueTokens(await loadUser(), undefined, undefined, 'reporting:ingest');
    const profileCtl = await import('../src/controllers/user-profile.js');
    const caller = token.verifyAccessToken(scoped.accessToken);

    // No scope requested → the caller's scope is kept.
    const r1 = res();
    await profileCtl.generateToken({ user: caller, headers: {}, body: {} } as never, r1);
    expect(r1.status).toHaveBeenCalledWith(200);
    const minted = jwt.decode(r1.json.mock.calls[0][0].data.accessToken) as { scope?: string };
    expect(minted.scope).toBe('reporting:ingest');
  });

  it('generate-token from a scoped PAT (no session slot) cannot drop the scope', async () => {
    const pat = await token.signPersonalAccessToken(await loadUser(), undefined, 'pat-jti-1', 3600, 'reporting:ingest');
    const profileCtl = await import('../src/controllers/user-profile.js');
    const caller = token.verifyAccessToken(pat);
    expect((caller as { sid?: string }).sid).toBeUndefined();

    const r = res();
    await profileCtl.generateToken({ user: caller, headers: {}, body: {} } as never, r);
    expect(r.status).toHaveBeenCalledWith(200);
    const minted = jwt.decode(r.json.mock.calls[0][0].data.accessToken) as { scope?: string; permissions?: string[] };
    expect(minted.scope).toBe('reporting:ingest');
    expect(minted.permissions).toEqual([]);
  });

  it('sign-out-everywhere (tokenVersion bump + clear) rejects every slot', async () => {
    const a = await token.issueTokens(await loadUser());
    const b = await token.issueTokens(await loadUser());
    const { authService } = await import('../src/services/auth-service.js');
    await authService.invalidateAllSessions(userId);
    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await refresh(b.refreshToken)).status).toBe(401);
    expect(await slots()).toHaveLength(0);
  });
});
