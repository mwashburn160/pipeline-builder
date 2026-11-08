// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /admin/console-session — that entering a console is AUDITED, once.
 *
 * The cookie this mints used to be written by the dashboard with
 * `document.cookie`, so opening a read/write shell over every tenant's rows
 * produced no server-side record: every FAILED console check was logged and
 * audited, every SUCCESSFUL one was not. The gateway's `auth_request` check
 * cannot carry the row — nginx fires it per asset, so one Grafana dashboard
 * would write dozens — which is what makes this route, called once per entry,
 * the only place it can live.
 *
 * So these lock four things that would each silently undo that: the row is
 * written, it names the class, the cookie never outlives its token, and the
 * class's own permission is required HERE and not only at the gateway.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const audit = jest.fn<(req: unknown, action: string, opts?: Record<string, unknown>) => void>();
const logInfo = jest.fn();

jest.unstable_mockModule('../src/helpers/audit.js', () => ({
  audit: (...a: unknown[]) => audit(...(a as [unknown, string, Record<string, unknown>])),
}));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: jest.fn(),
  observe: jest.fn(),
  setGauge: jest.fn(),
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: (...a: unknown[]) => logInfo(...a),
  }),
  // Exercised through its own suites; here it must not stand between the
  // caller and the row being asserted.
  requireAssurance: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const SYSTEM_ORG = '000000000000000000000001';

/** Seconds of life left on the token the fake `requireAuth` mints. */
let tokenTtlSeconds = 900;
/** The permissions claim — `null` for a superadmin, who holds all three. */
let permissions: string[] | null = null;

jest.unstable_mockModule('../src/middleware/index.js', () => ({
  requireAuth: (req: any, _res: any, next: () => void) => {
    req.user = {
      sub: 'u-1',
      organizationId: SYSTEM_ORG,
      exp: Math.floor(Date.now() / 1000) + tokenTtlSeconds,
      ...(permissions === null ? { isSuperAdmin: true } : { isSuperAdmin: false, permissions }),
    };
    next();
  },
  requireSystemAdmin: (req: any, res: any, next: () => void) => {
    if (req.user?.isSuperAdmin === true) return next();
    return res.status(403).json({ success: false, message: 'Forbidden: system administrator access required' });
  },
}));

const { adminConsoleSessionRouter: router } = await import('../src/routes/admin-console.js');

interface Call {
  status: number;
  body?: any;
  cookies: Array<{ name: string; value: string; opts: Record<string, any> }>;
}

/**
 * Drive the POST chain with a fake req/res.
 *
 * `authorization` is deliberately separate from `reqHeaders`: the handler reads
 * the bearer back off the header to put it IN the cookie, so a case that omits
 * it is testing a real branch rather than a malformed fixture.
 */
async function call(
  reqHeaders: Record<string, string> = {},
  authorization: string | null = 'Bearer tok-abc',
): Promise<Call> {
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/' && l.route?.methods?.post);
  const handlers = layer.route.stack.map((s: any) => s.handle);
  const all = { ...reqHeaders, ...(authorization === null ? {} : { Authorization: authorization }) };
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v]));
  const cookies: Call['cookies'] = [];
  const req: any = {
    method: 'POST',
    url: '/',
    originalUrl: '/admin/console-session',
    headers: lower,
    header: (name: string) => lower[name.toLowerCase()],
  };
  const res: any = { statusCode: 200, headersSent: false };
  res.setHeader = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.end = () => res;
  res.cookie = (name: string, value: string, opts: Record<string, any>) => { cookies.push({ name, value, opts }); return res; };

  for (const h of handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return { status: res.statusCode, body: res.body, cookies };
}

describe('POST /admin/console-session — the entry is audited', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tokenTtlSeconds = 900;
    permissions = null;
  });

  it('writes ONE audit row naming the console class', async () => {
    const { status } = await call({ 'X-PB-Console': 'database' });

    expect(status).toBe(204);
    expect(audit).toHaveBeenCalledTimes(1);
    const [, action, opts] = audit.mock.calls[0] as [unknown, string, any];
    expect(action).toBe('admin.console.session');
    // `targetId` is the class, so the audit UI can filter "who opened a
    // DATABASE console" without parsing `details`.
    expect(opts).toMatchObject({ targetType: 'admin-console', targetId: 'database' });
    expect(opts.details).toMatchObject({ consoleClass: 'database' });
  });

  it('hands back the caller’s own token in the cookie, scoped and Secure', async () => {
    const { cookies } = await call({ 'X-PB-Console': 'observability' });

    expect(cookies).toHaveLength(1);
    const [cookie] = cookies;
    expect(cookie.name).toBe('pb_admin_console');
    // The caller's OWN token: this route grants nothing it did not already
    // hold, which is why minting it is safe to do on the caller's behalf.
    expect(cookie.value).toBe('tok-abc');
    expect(cookie.opts).toMatchObject({ secure: true, sameSite: 'strict', path: '/' });
  });

  it('NOT httpOnly — the dashboard reads it back to follow token rotation', async () => {
    const { cookies } = await call({ 'X-PB-Console': 'observability' });

    // Asserted explicitly because it looks like an oversight and is not:
    // `syncAdminConsoleCookie` re-writes this cookie when the access token
    // rotates, which it can only do if it can read the current one. HttpOnly
    // would break an open console at the first refresh, and buys little — the
    // token in it is the one the SPA already holds.
    expect(cookies[0].opts.httpOnly).toBeUndefined();
  });

  it('expires the cookie WITH the token, never after it', async () => {
    tokenTtlSeconds = 120;
    const { cookies } = await call({ 'X-PB-Console': 'database' });

    // A cookie outliving its token makes the gateway answer 401 on every asset,
    // so the console reads as broken rather than as expired.
    expect(cookies[0].opts.maxAge).toBeLessThanOrEqual(120_000);
    expect(cookies[0].opts.maxAge).toBeGreaterThan(110_000);
  });

  it('refuses an already-expired token without minting anything', async () => {
    tokenTtlSeconds = -1;
    const { status, cookies } = await call({ 'X-PB-Console': 'database' });

    expect(status).toBe(401);
    expect(cookies).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses when there is no bearer to put in the cookie', async () => {
    const { status, cookies, body } = await call({ 'X-PB-Console': 'database' }, null);

    expect(status).toBe(400);
    expect(cookies).toHaveLength(0);
    expect(body?.code).toBe('TOKEN_MISSING');
    expect(audit).not.toHaveBeenCalled();
  });

  it('requires the class’s OWN permission here, not only at the gateway', async () => {
    // A Console Administrator holding observability only. If this route gated
    // on anything weaker than the check it mints for, it would be the way
    // around the check.
    permissions = ['observability_console:open'];
    const { status, cookies } = await call({ 'X-PB-Console': 'database' });

    expect(status).toBe(403);
    expect(cookies).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('admits the class the caller DOES hold', async () => {
    permissions = ['observability_console:open'];
    const { status } = await call({ 'X-PB-Console': 'observability' });

    expect(status).toBe(204);
  });

  it('falls back to the superadmin flag for an unnamed console', async () => {
    // `unrecognised` maps to `requireSystemAdmin`, deliberately the strongest
    // gate: a console added to nginx and named nowhere is treated as the most
    // dangerous thing it could be.
    permissions = ['database_console:open'];
    const refused = await call({ 'X-PB-Console': 'not-a-console' });
    expect(refused.status).toBe(403);

    permissions = null;
    const admitted = await call({ 'X-PB-Console': 'not-a-console' });
    expect(admitted.status).toBe(204);
    expect(audit.mock.calls[0]![2]).toMatchObject({ targetId: 'unrecognised' });
  });

  it('logs the entry with the operator, for the 30-day log window', async () => {
    await call({ 'X-PB-Console': 'objectstore' });

    expect(logInfo).toHaveBeenCalledWith('Admin console session minted', expect.objectContaining({
      consoleClass: 'objectstore',
      userId: 'u-1',
      orgId: SYSTEM_ORG,
    }));
  });
});
