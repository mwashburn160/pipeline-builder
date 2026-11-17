// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Mongo test for per-device refresh-session slots: the positional,
 * hash-matched rotation and the per-KIND caps (aggregation-pipeline update) can
 * only be proven against a real server.
 *
 * Drives the REAL `requireRefreshSession` middleware + `refresh` / `logout` /
 * `generate-token` / sessions controllers end to end:
 *   - each sign-in opens its own INTERACTIVE slot; the oldest is evicted past the cap;
 *   - refresh rotates only its own slot;
 *   - reusing an already-rotated token revokes THAT slot, not the others;
 *   - logout clears only the current slot; a tokenVersion bump kills them all;
 *   - a scoped slot keeps its scope through renewal and can never be re-minted
 *     unscoped or under another scope (no machine-token privilege escalation);
 *   - MACHINE slots (generate-token) live under their own cap, survive the
 *     operator's sign-ins and refreshes, rotate in place through their own
 *     refresh token, and can never open another slot;
 *   - switch-org moves its slot's org and returns an ACCESS token only (the
 *     slot's refresh token is untouched), the next refresh lands in the
 *     switched org, slots keep independent orgs, and a slot pinned to an org
 *     the user has left falls back to one they are still in;
 *   - a just-rotated token is answered from the rotation grace, and is reuse
 *     once the grace has passed;
 *   - sessions and devices: the slot list records device details, marks the
 *     current session, refuses self-revoke, and revoking stops renewal.
 *
 * Gated behind RUN_MONGO_INTEGRATION=1 (skipped by default) — mirrors
 * organization-id-storage.integration.test.ts.
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { integrationSuite } from './helpers/integration-gate.js';

process.env.SECRET_ENCRYPTION_KEY ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

const MONGOD_VERSION = process.env.MONGOMS_VERSION || '6.0.14';
const suite = integrationSuite();

suite('refresh-session slots (real Mongo)', () => {
  let mongod: { getUri: () => string; stop: () => Promise<boolean> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mongoose: any, User: any, RefreshSession: any, Organization: any, UserOrganization: any, token: any, authMw: any, authCtl: any, credsCtl: any, jwt: any;
  /** Let the refresh-rotation grace lapse (it lives in the pending-state store). */
  let endRotationGrace: () => void;

  beforeAll(async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoose = (await import('mongoose')).default;
    mongod = await MongoMemoryServer.create({ binary: { version: MONGOD_VERSION } });
    process.env.MONGODB_URI = mongod.getUri();
    await mongoose.connect(process.env.MONGODB_URI);
    ({ User, RefreshSession, Organization, UserOrganization } = await import('../src/models/index.js'));
    // TTL / unique indexes, so the duplicate-id guarantee is real here.
    await RefreshSession.init();
    ({ _resetAllPendingStoresForTests: endRotationGrace } = await import('../src/helpers/pending-state-store.js'));
    token = {
      ...(await import('../src/services/session/membership-context.js')),
      ...(await import('../src/services/session/access-tokens.js')),
      ...(await import('../src/services/session/refresh-sessions.js')),
      ...(await import('../src/utils/token.js')),
    };
    authMw = await import('../src/middleware/auth.js');
    authCtl = await import('../src/controllers/auth.js');
    // Session + credential handlers live in user-credentials.ts; user-profile.ts
    // keeps only profile and preferences.
    credsCtl = await import('../src/controllers/user-credentials.js');
    jwt = (await import('jsonwebtoken')).default;
    // Platform signs every user token with ES256; install an in-memory key so
    // the real token module can mint (and verify) them here.
    (await import('./helpers/signing.js')).installTestSigningKeys();
  }, 120_000);

  afterAll(async () => {
    if (mongoose) await mongoose.disconnect();
    if (mongod) await mongod.stop();
  });

  let userId: string;
  beforeEach(async () => {
    await User.deleteMany({});
    await RefreshSession.deleteMany({});
    await Organization.deleteMany({});
    await UserOrganization.deleteMany({});
    const u = await User.create({ username: 'dev', email: 'dev@example.com', isEmailVerified: true });
    userId = String(u._id);
  });

  const loadUser = () => User.findById(userId).select('+tokenVersion +isSuperAdmin');
  /** The user's slots (their own collection), oldest first. */
  const slots = async () => (await RefreshSession.find({ userId }).sort({ createdAt: 1, _id: 1 }).lean()) as Array<{
    id: string;
    kind: string;
    hash: string;
    scope?: string;
    lastUsedAt: Date;
    userAgent?: string;
    lastIp?: string;
    tokenVersion: number;
    authTime: Date;
    purgeAt: Date;
    expiresAt?: Date;
  }>;
  const sidOf = (t: string) => (jwt.decode(t) as { sid: string }).sid;
  const slotOf = async (t: string) => (await slots()).find((sl) => sl.id === sidOf(t))!;

  /** A password sign-in (what login / OAuth / SSO do). */
  const login = (extra: Record<string, unknown> = {}) => ({
    kind: 'interactive' as const,
    auth: token.signInAuth('pwd'),
    client: { userAgent: 'Chrome on macOS', ip: '203.0.113.7' },
    ...extra,
  });
  const signIn = async (extra: Record<string, unknown> = {}) => token.issueTokens(await loadUser(), undefined, login(extra));

  function res() {
    const r: any = { locals: {} };
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    // The session endpoints set/clear the browser's refresh cookie through
    // these (helpers/session-cookie.ts); Express always provides them.
    r.cookie = jest.fn(() => r);
    r.clearCookie = jest.fn(() => r);
    return r;
  }

  /**
   * POST /auth/refresh through the real middleware + controller.
   *
   * Defaults to the CLI transport (token in the body, no client header); pass
   * `{ browser: true }` to present it the way a browser does — in the
   * `pb_refresh` cookie, with `X-Pb-Client: web`.
   */
  async function refresh(
    refreshToken: string,
    opts: { browser?: boolean } = {},
  ): Promise<{ status: number; body: any; res: any }> {
    const req: any = opts.browser
      ? { body: {}, headers: { 'x-pb-client': 'web', 'cookie': `pb_refresh=${refreshToken}` } }
      : { body: { refreshToken }, headers: {} };
    const r = res();
    let passed = false;
    await authMw.requireRefreshSession(req, r, () => { passed = true; });
    if (passed) await authCtl.refresh(req, r);
    return { status: r.status.mock.calls[0]?.[0], body: r.json.mock.calls[0]?.[0], res: r };
  }

  /** Run a controller against a minimal request and read its response. */
  async function run(handler: any, req: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const r = res();
    await handler({ headers: {}, params: {}, body: {}, ...req } as never, r);
    return { status: r.status.mock.calls[0]?.[0], body: r.json.mock.calls[0]?.[0] };
  }

  /** POST /user/generate-token as `caller` (verified access-token claims). */
  const generateToken = (caller: Record<string, unknown>, body: Record<string, unknown> = {}) =>
    run(credsCtl.generateToken, { user: caller, body, ip: '198.51.100.9' });

  it('opens one slot per sign-in and evicts the oldest past the cap', async () => {
    const issued = [];
    for (let i = 0; i < token.MAX_REFRESH_SESSIONS + 1; i += 1) issued.push(await signIn());
    const ids = (await slots()).map((s) => s.id);
    expect(ids).toHaveLength(token.MAX_REFRESH_SESSIONS);
    expect(ids).not.toContain(sidOf(issued[0].refreshToken));
    expect(ids).toContain(sidOf(issued.at(-1).refreshToken));
    // The access token names the same slot as its refresh token.
    expect(sidOf(issued[1].accessToken)).toBe(sidOf(issued[1].refreshToken));
  });

  it('rotates only the refreshed slot', async () => {
    const a = await signIn();
    const b = await signIn();
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

  it('rotates a BROWSER session through the cookie, never through the body', async () => {
    const a = await signIn();

    const out = await refresh(a.refreshToken, { browser: true });
    expect(out.status).toBe(200);
    // Nothing token-shaped a script could read comes back in the body.
    expect(out.body.data.refreshToken).toBeUndefined();

    const [, rotatedToken, attrs] = out.res.cookie.mock.calls[0];
    expect(attrs).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/api/auth/refresh' });
    expect(sidOf(rotatedToken)).toBe(sidOf(a.refreshToken));
    // The cookie the browser was just handed is the live credential; the one it
    // presented is now reuse, and takes its own slot down.
    expect((await refresh(rotatedToken, { browser: true })).status).toBe(200);
  });

  it('reuse of an already-rotated token revokes THAT slot only', async () => {
    const a = await signIn();
    const b = await signIn();
    const rotated = (await refresh(a.refreshToken)).body.data;

    // Inside the grace a concurrent loser gets the SAME replacement pair …
    const raced = await refresh(a.refreshToken);
    expect(raced.status).toBe(200);
    expect(raced.body.data.refreshToken).toBe(rotated.refreshToken);

    // … past it, the rotated-away token is reuse.
    endRotationGrace();
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
    const a = await signIn();
    const b = await signIn();
    const req: any = { user: token.verifyAccessToken(a.accessToken), headers: {}, body: {} };
    const r = res();
    await authCtl.logout(req, r);
    expect(r.status).toHaveBeenCalledWith(200);

    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await refresh(b.refreshToken)).status).toBe(200);
  });

  /** Two orgs the user is a member of; `first` is the earlier membership. */
  async function twoOrgs(): Promise<{ first: string; second: string }> {
    const owner = new mongoose.Types.ObjectId();
    const first = await Organization.create({ name: 'First', owner, tier: 'team' });
    const second = await Organization.create({ name: 'Second', owner, tier: 'team' });
    await UserOrganization.create({ userId, organizationId: first._id, role: 'member', isActive: true, joinedAt: new Date(1000) });
    await UserOrganization.create({ userId, organizationId: second._id, role: 'member', isActive: true, joinedAt: new Date(2000) });
    return { first: String(first._id), second: String(second._id) };
  }
  const orgOf = (t: string) => (jwt.decode(t) as { organizationId?: string }).organizationId;

  /** POST /auth/switch-org holding only `accessToken`. */
  const switchOrg = (accessToken: string, organizationId: string, headers: Record<string, string> = {}) =>
    run(authCtl.switchOrg, { user: token.verifyAccessToken(accessToken), headers, body: { organizationId } });

  it('a sign-in records its org on the slot', async () => {
    const { first } = await twoOrgs();
    const a = await signIn();
    expect(orgOf(a.accessToken)).toBe(first);
    expect((await slotOf(a.refreshToken) as { activeOrgId?: string }).activeOrgId).toBe(first);
  });

  it.each([
    ['a CLI', { 'x-pb-client': 'cli' }],
    ['a browser', { 'x-pb-client': 'web' }],
  ])('REGRESSION: switch-org with only an access token returns NO refresh token to %s and leaves the slot\'s refresh hash alone', async (_label, headers) => {
    const { second } = await twoOrgs();
    const a = await signIn();
    const before = await slotOf(a.refreshToken);

    const r = res();
    await authCtl.switchOrg({ user: token.verifyAccessToken(a.accessToken), headers, params: {}, body: { organizationId: second } } as never, r);
    expect(r.status).toHaveBeenCalledWith(200);
    const body = r.json.mock.calls[0][0];
    expect(Object.keys(body.data).sort()).toEqual(['accessToken', 'expiresIn']);
    expect(r.cookie).not.toHaveBeenCalled();
    expect(orgOf(body.data.accessToken)).toBe(second);
    expect(sidOf(body.data.accessToken)).toBe(sidOf(a.refreshToken));

    const after = await slotOf(a.refreshToken) as { hash: string; activeOrgId?: string };
    expect(after.hash).toBe(before.hash);
    expect(after.activeOrgId).toBe(second);
    expect(await slots()).toHaveLength(1);
    // The legitimate holder's refresh token still works — it was not rotated out.
    expect((await refresh(a.refreshToken)).status).toBe(200);
  });

  it('refresh after a switch lands in the switched org', async () => {
    const { first, second } = await twoOrgs();
    const a = await signIn();
    expect(orgOf(a.accessToken)).toBe(first);
    expect((await switchOrg(a.accessToken, second)).status).toBe(200);

    const out = await refresh(a.refreshToken);
    expect(out.status).toBe(200);
    expect(orgOf(out.body.data.accessToken)).toBe(second);
    // And it stays there across further rotations.
    expect(orgOf((await refresh(out.body.data.refreshToken)).body.data.accessToken)).toBe(second);
  });

  it('two slots (tabs / a CLI) keep independent orgs across a switch', async () => {
    const { first, second } = await twoOrgs();
    const tab = await signIn();
    const cli = await signIn();
    expect((await switchOrg(tab.accessToken, second)).status).toBe(200);
    // The switch moved `lastActiveOrgId` (where the NEXT sign-in lands) …
    expect(String((await loadUser()).lastActiveOrgId)).toBe(second);

    // … but the other slot renews into its OWN org, not the one the tab picked.
    expect(orgOf((await refresh(cli.refreshToken)).body.data.accessToken)).toBe(first);
    expect(orgOf((await refresh(tab.refreshToken)).body.data.accessToken)).toBe(second);
  });

  it('a slot pinned to an org the user has LEFT falls back to one they are still in — never mints for the left org', async () => {
    const { first, second } = await twoOrgs();
    const a = await signIn();
    expect((await switchOrg(a.accessToken, second)).status).toBe(200);
    await UserOrganization.deleteOne({ userId, organizationId: second });

    const out = await refresh(a.refreshToken);
    expect(out.status).toBe(200);
    expect(orgOf(out.body.data.accessToken)).toBe(first);
    // The slot is re-pinned to the org it actually renewed into.
    expect((await slotOf(a.refreshToken) as { activeOrgId?: string }).activeOrgId).toBe(first);
  });

  it('a slot that predates activeOrgId renews as before (lastActiveOrgId)', async () => {
    const { second } = await twoOrgs();
    const a = await signIn();
    await RefreshSession.updateMany({ userId }, { $unset: { activeOrgId: '' } });
    await User.updateOne({ _id: userId }, { $set: { lastActiveOrgId: second } });
    expect(orgOf((await refresh(a.refreshToken)).body.data.accessToken)).toBe(second);
  });

  it('generate-token opens (and renews) a machine credential in the CALLER slot\'s org, not another device\'s switch', async () => {
    const { first, second } = await twoOrgs();
    const cli = await signIn();
    const browser = await signIn();
    expect((await switchOrg(browser.accessToken, second)).status).toBe(200);

    const machine = await generateToken(token.verifyAccessToken(cli.accessToken));
    expect(machine.status).toBe(200);
    expect(orgOf(machine.body.data.accessToken)).toBe(first);
    const renewed = await generateToken(token.verifyAccessToken(machine.body.data.accessToken));
    expect(orgOf(renewed.body.data.accessToken)).toBe(first);
  });

  it('switch-org refuses an org the user is not in, and a removed slot — the slot is unchanged', async () => {
    const { first } = await twoOrgs();
    const a = await signIn();
    const stranger = String((await Organization.create({ name: 'Other', owner: new mongoose.Types.ObjectId(), tier: 'team' }))._id);
    expect((await switchOrg(a.accessToken, stranger)).status).toBe(403);
    expect((await slotOf(a.refreshToken) as { activeOrgId?: string }).activeOrgId).toBe(first);

    await RefreshSession.deleteMany({ userId });
    expect(await token.switchSessionOrg(await loadUser(), first, sidOf(a.refreshToken))).toBe('session-invalid');
    expect(await token.renewSessionTokens(await loadUser(), undefined, { sessionId: sidOf(a.refreshToken) })).toBeNull();
  });

  it('a machine slot keeps its scope through renewal and can never be re-minted under another scope', async () => {
    const scoped = await token.issueTokens(await loadUser(), undefined, {
      kind: 'machine', auth: token.signInAuth('pwd'), scope: 'reporting:ingest',
    });
    expect((jwt.decode(scoped.accessToken) as { scope?: string }).scope).toBe('reporting:ingest');
    const sessionId = sidOf(scoped.accessToken);

    // Omitting the scope keeps it, and the renewed token stays least-privilege …
    const kept = await token.renewSessionTokens(await loadUser(), undefined, { sessionId, kind: 'machine' });
    const renewed = jwt.decode(kept.accessToken) as { scope?: string; permissions?: string[] };
    expect(renewed.scope).toBe('reporting:ingest');
    expect(renewed.permissions).toEqual([]);
    // … and asking for a different one is refused.
    await expect(token.renewSessionTokens(await loadUser(), undefined, { sessionId, kind: 'machine' }, { scope: 'other:scope' }))
      .rejects.toThrow('TOKEN_SCOPE_ESCALATION');
  });

  it('a machine slot rotates in place through its own refresh token', async () => {
    const machine = await token.issueTokens(await loadUser(), undefined, { kind: 'machine', auth: token.signInAuth('pwd') });
    const out = await refresh(machine.refreshToken);
    expect(out.status).toBe(200);
    expect(sidOf(out.body.data.refreshToken)).toBe(sidOf(machine.refreshToken));
    const slot = await slotOf(machine.accessToken);
    expect(slot.kind).toBe('machine');
    expect(slot.hash).toBe(token.hashRefreshToken(out.body.data.refreshToken));
  });

  it('EVICTION: ten later sign-ins never drop a stored machine credential', async () => {
    const machine = await generateToken(token.verifyAccessToken((await signIn()).accessToken));
    const machineSid = sidOf(machine.body.data.accessToken);

    for (let i = 0; i < token.MAX_REFRESH_SESSIONS + 1; i += 1) await signIn();

    const all = await slots();
    expect(all.filter((sl) => sl.kind === 'interactive')).toHaveLength(token.MAX_REFRESH_SESSIONS);
    expect(all.find((sl) => sl.id === machineSid)?.kind).toBe('machine');
    // … and it still renews.
    expect((await generateToken(token.verifyAccessToken(machine.body.data.accessToken))).status).toBe(200);
  });

  it('OPERATOR REFRESH: the operator refreshing their login does not end the credential it created', async () => {
    const operator = await signIn();
    const machine = await generateToken(token.verifyAccessToken(operator.accessToken));

    // The operator's CLI refreshes the login it used, then reuses the old token —
    // which revokes the operator's OWN slot (presumed stolen) …
    expect((await refresh(operator.refreshToken)).status).toBe(200);
    endRotationGrace();
    expect((await refresh(operator.refreshToken)).status).toBe(401);
    expect((await slots()).map((sl) => sl.id)).not.toContain(sidOf(operator.accessToken));

    // … while the machine credential is untouched and still renews.
    expect((await generateToken(token.verifyAccessToken(machine.body.data.accessToken))).status).toBe(200);
  });

  it('SCOPE LEAK: two store-token runs from ONE login yield independent slots with their own scopes', async () => {
    const operator = token.verifyAccessToken((await signIn()).accessToken);
    const platformToken = await generateToken(operator);
    const ingestToken = await generateToken(operator, { scope: 'reporting:ingest' });

    const machineSlots = (await slots()).filter((sl) => sl.kind === 'machine');
    expect(machineSlots).toHaveLength(2);
    expect(sidOf(platformToken.body.data.accessToken)).not.toBe(sidOf(ingestToken.body.data.accessToken));
    expect((jwt.decode(platformToken.body.data.accessToken) as { scope?: string }).scope).toBeUndefined();
    expect((jwt.decode(ingestToken.body.data.accessToken) as { scope?: string }).scope).toBe('reporting:ingest');
    // The operator's own slot is left alone (it is neither of the two).
    expect((await slots()).filter((sl) => sl.kind === 'interactive')).toHaveLength(1);

    // Renewing the full-access credential does NOT come back scoped (the old leak).
    const renewedPlatform = await generateToken(token.verifyAccessToken(platformToken.body.data.accessToken));
    expect((jwt.decode(renewedPlatform.body.data.accessToken) as { scope?: string }).scope).toBeUndefined();
    // Renewing the scoped one keeps its scope, in place.
    const renewedIngest = await generateToken(token.verifyAccessToken(ingestToken.body.data.accessToken));
    expect(sidOf(renewedIngest.body.data.accessToken)).toBe(sidOf(ingestToken.body.data.accessToken));
    expect((jwt.decode(renewedIngest.body.data.accessToken) as { scope?: string }).scope).toBe('reporting:ingest');
  });

  it('a machine session renews in place and can never open a second slot', async () => {
    const machine = await generateToken(token.verifyAccessToken((await signIn()).accessToken));
    const before = (await slots()).filter((sl) => sl.kind === 'machine');

    const renewed = await generateToken(token.verifyAccessToken(machine.body.data.accessToken));
    expect(renewed.status).toBe(200);
    // The same slot's refresh token, rotated — not a second credential.
    expect(sidOf(renewed.body.data.refreshToken)).toBe(sidOf(machine.body.data.refreshToken));
    const after = (await slots()).filter((sl) => sl.kind === 'machine');
    expect(after).toHaveLength(before.length);
    expect(sidOf(renewed.body.data.accessToken)).toBe(sidOf(machine.body.data.accessToken));
  });

  it('machine slots have their own cap, dropping the LEAST RECENTLY USED', async () => {
    const operator = token.verifyAccessToken((await signIn()).accessToken);
    const minted = [];
    for (let i = 0; i < token.MAX_MACHINE_SESSIONS; i += 1) minted.push(await generateToken(operator));

    // Renew the FIRST credential so it becomes the most recently used …
    await generateToken(token.verifyAccessToken(minted[0].body.data.accessToken));
    // … then open one more, which must evict the least recently used (the second).
    await generateToken(operator);

    const ids = (await slots()).filter((sl) => sl.kind === 'machine').map((sl) => sl.id);
    expect(ids).toHaveLength(token.MAX_MACHINE_SESSIONS);
    expect(ids).toContain(sidOf(minted[0].body.data.accessToken));
    expect(ids).not.toContain(sidOf(minted[1].body.data.accessToken));
  });

  it('generate-token refuses an access-key token (no session slot) and opens nothing', async () => {
    // An exchanged access-key token: `token_use: 'api_key'`, no `sid`. Revoking
    // the key must not leave a long-lived credential derived from it behind.
    const keyToken = await token.signApiKeyToken(
      await loadUser(), undefined, 'key-id-1', token.signInAuth('pwd'), 'reporting:ingest',
    );
    const caller = token.verifyAccessToken(keyToken);
    expect((caller as { sid?: string }).sid).toBeUndefined();
    expect(caller.token_use).toBe('api_key');

    const out = await generateToken(caller);
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('SESSION_SLOT_REQUIRED');
    expect((await slots()).filter((sl) => sl.kind === 'machine')).toHaveLength(0);
  });

  it('generate-token refuses a caller whose own slot is gone (revoked or evicted)', async () => {
    const a = await signIn();
    const caller = token.verifyAccessToken(a.accessToken);
    await authCtl.logout({ user: caller, headers: {}, body: {} } as never, res());
    expect((await generateToken(caller)).status).toBe(401);
  });

  it('renewal never raises the assurance level or resets the sign-in time', async () => {
    const a = await signIn();
    const before = jwt.decode(a.accessToken) as { aal: number; auth_time: number; amr: string[] };
    const out = await refresh(a.refreshToken);
    const after = jwt.decode(out.body.data.accessToken) as { aal: number; auth_time: number; amr: string[] };
    expect(after).toMatchObject({ aal: before.aal, auth_time: before.auth_time, amr: before.amr });
  });

  it('sessions list records device details, marks the current session, and revoking one stops renewal', async () => {
    const operator = await signIn();
    const caller = token.verifyAccessToken(operator.accessToken);
    const machine = await generateToken(caller);

    const listed = await run(credsCtl.listSessions, { user: caller });
    expect(listed.status).toBe(200);
    expect(listed.body.data.sessions).toHaveLength(1);
    expect(listed.body.data.sessions[0]).toMatchObject({
      kind: 'interactive', current: true, userAgent: 'Chrome on macOS', lastIp: '203.0.113.7', amr: ['pwd'],
    });
    expect(listed.body.data.machineSessions).toHaveLength(1);
    expect(listed.body.data.machineSessions[0]).toMatchObject({ kind: 'machine', current: false, scope: null });

    // The current session can't revoke itself (that's logout).
    expect((await run(credsCtl.revokeSession, { user: caller, params: { id: caller.sid } })).status).toBe(400);

    // Revoking the machine session stops its renewal.
    const machineSid = sidOf(machine.body.data.accessToken);
    expect((await run(credsCtl.revokeSession, { user: caller, params: { id: machineSid } })).status).toBe(200);
    expect((await generateToken(token.verifyAccessToken(machine.body.data.accessToken))).status).toBe(401);
    // Unknown slot → 404.
    expect((await run(credsCtl.revokeSession, { user: caller, params: { id: 'nope' } })).status).toBe(404);
  });

  it('sign-out-everywhere (tokenVersion bump + clear) rejects every slot', async () => {
    const a = await signIn();
    const b = await signIn();
    const { authService } = await import('../src/services/auth-service.js');
    await authService.invalidateAllSessions(userId);
    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await refresh(b.refreshToken)).status).toBe(401);
    expect(await slots()).toHaveLength(0);
  });

  it('a slot left at an OLD tokenVersion is dead even if the bump never deleted it', async () => {
    const a = await signIn();
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
    // The refresh token itself names the old version → refused at the door.
    expect((await refresh(a.refreshToken)).status).toBe(401);
    // A renewal for that slot at the NEW version finds no live slot either.
    expect(await token.renewSessionTokens(await loadUser(), undefined, { sessionId: sidOf(a.refreshToken) })).toBeNull();
    // ...and the sessions list does not show it.
    const listed = await run(credsCtl.listSessions, { user: { sub: userId } });
    expect(listed.body.data.sessions).toHaveLength(0);
  });

  it('stores a slot as its own row: tokenVersion, auth context and a purge time bounded by the maximum age', async () => {
    const a = await signIn();
    const [row] = await slots();
    expect(row.id).toBe(sidOf(a.refreshToken));
    expect(row.tokenVersion).toBe(0);
    const maxAgeEnd = new Date(row.authTime).getTime() + 30 * 86400_000;
    expect(new Date(row.purgeAt).getTime()).toBeLessThanOrEqual(maxAgeEnd);
    // The user document carries no slots any more.
    const raw = await mongoose.connection.db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
    expect(raw.refreshSessions).toBeUndefined();
  });

  describe('session lifetime', () => {
    const DAY = 86400_000;
    /** Age the slot behind `t`: signed in `signedInDaysAgo`, last used `usedDaysAgo`. */
    const age = async (t: string, signedInDaysAgo: number, usedDaysAgo: number) => {
      await RefreshSession.updateOne(
        { userId, id: sidOf(t) },
        { $set: { authTime: new Date(Date.now() - signedInDaysAgo * DAY), lastUsedAt: new Date(Date.now() - usedDaysAgo * DAY) } },
      );
    };

    it('an active session inside both bounds keeps refreshing', async () => {
      const a = await signIn();
      await age(a.refreshToken, 20, 1);
      expect((await refresh(a.refreshToken)).status).toBe(200);
    });

    it('a session idle past the platform idle timeout (7d) is refused with SESSION_EXPIRED and dropped', async () => {
      const a = await signIn();
      const b = await signIn();
      await age(a.refreshToken, 8, 8);
      const out = await refresh(a.refreshToken, { browser: true });
      expect(out.status).toBe(401);
      expect(out.body.code).toBe('SESSION_EXPIRED');
      // The dead cookie is cleared, the slot is gone, and other devices are untouched.
      expect(out.res.clearCookie).toHaveBeenCalled();
      expect((await slots()).map((sl) => sl.id)).toEqual([sidOf(b.refreshToken)]);
      expect((await refresh(b.refreshToken)).status).toBe(200);
    });

    it('a session past the maximum age (30d from sign-in) is refused however active it is', async () => {
      const a = await signIn();
      await age(a.refreshToken, 31, 0);
      const out = await refresh(a.refreshToken);
      expect(out.status).toBe(401);
      expect(out.body.code).toBe('SESSION_EXPIRED');
    });

    it('renewal never resets the sign-in time, and caps the refresh token at the maximum age', async () => {
      const a = await signIn();
      await age(a.refreshToken, 29, 0);
      const out = await refresh(a.refreshToken);
      expect(out.status).toBe(200);
      const rt = jwt.decode(out.body.data.refreshToken) as { exp: number };
      expect(rt.exp * 1000 - Date.now()).toBeLessThanOrEqual(DAY + 5000);
      expect(Date.now() - new Date((await slotOf(a.refreshToken)).authTime).getTime()).toBeGreaterThan(28 * DAY);
    });

    it('an org may TIGHTEN the policy (strictest down the org tree), enforced at the next refresh', async () => {
      const { first } = await twoOrgs();
      const a = await signIn();
      await age(a.refreshToken, 3, 1);
      expect((await refresh(a.refreshToken)).status).toBe(200);
      await Organization.updateOne({ _id: first }, { $set: { sessionPolicy: { maxAgeDays: 2 } } });
      await age(a.refreshToken, 3, 0);
      const out = await refresh(a.refreshToken);
      expect(out.status).toBe(401);
      expect(out.body.code).toBe('SESSION_EXPIRED');
    });

    it('an ancestor\'s stricter idle timeout governs a team session', async () => {
      const owner = new mongoose.Types.ObjectId();
      const root = await Organization.create({ name: 'Root', owner, tier: 'team', sessionPolicy: { idleTimeoutDays: 1 } });
      const team = await Organization.create({ name: 'Team', owner, tier: 'team', parentOrgId: String(root._id) });
      await UserOrganization.create({ userId, organizationId: team._id, role: 'member', isActive: true, joinedAt: new Date(1000) });
      const a = await signIn();
      expect(orgOf(a.accessToken)).toBe(String(team._id));
      await age(a.refreshToken, 2, 2);
      expect((await refresh(a.refreshToken)).body.code).toBe('SESSION_EXPIRED');
    });

    it('switch-org into an org whose policy the session is too old for is refused — the session itself survives', async () => {
      const { first, second } = await twoOrgs();
      await Organization.updateOne({ _id: second }, { $set: { sessionPolicy: { maxAgeDays: 1 } } });
      const a = await signIn();
      expect(orgOf(a.accessToken)).toBe(first);
      await age(a.refreshToken, 2, 0);
      const out = await switchOrg(a.accessToken, second);
      expect(out.status).toBe(403);
      expect(out.body.code).toBe('SESSION_POLICY_REAUTH_REQUIRED');
      expect(await slotOf(a.refreshToken)).toBeDefined();
      expect((await refresh(a.refreshToken)).status).toBe(200);
    });

    it('machine slots are never idle-timed — only their own fixed end applies', async () => {
      const m = await token.issueTokens(await loadUser(), undefined, { kind: 'machine', auth: token.signInAuth('pwd'), lifetimeSeconds: 90 * 86400 });
      await age(m.refreshToken, 60, 20);
      expect((await refresh(m.refreshToken)).status).toBe(200);
      // Past its fixed end it is refused with the same code, and dropped.
      await RefreshSession.updateOne({ userId, id: sidOf(m.refreshToken) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const out = await refresh(m.refreshToken);
      expect(out.status).toBe(401);
      expect(out.body.code).toBe('SESSION_EXPIRED');
      expect(await slots()).toHaveLength(0);
    });
  });
});
