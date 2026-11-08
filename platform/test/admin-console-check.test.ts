// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /admin/console-check — that a refusal SAYS WHY.
 *
 * The route is an nginx `auth_request` subrequest, so the response body is
 * discarded by the gateway: whatever `sendError` puts in `code` never reaches
 * the browser, which sees a bare 401. Meanwhile `requireAuth`'s common
 * rejections log nothing, and `recordAuthzDenial` skips GET — so a refused
 * console check left no trace anywhere and had to be reproduced by hand from
 * inside the nginx pod.
 *
 * These lock the two halves: the reason reaches the log, and a PASS stays
 * silent (a line per successful console request would bury the refusals).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const logWarn = jest.fn();
const logInfo = jest.fn();
const incCounter = jest.fn<(name: string, labels?: Record<string, string>) => void>();

// The route module also carries `POST /session`, which audits — and `audit`
// reaches `src/config`, which refuses to load without an encryption key. Stubbed
// so this suite stays about the GET gate's refusals; the session route has its
// own suite (`admin-console-session.test.ts`).
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: jest.fn() }));
// The route counts admitted access through platform's own metrics wrapper
// (the convention here, 40 call sites to api-server's 4).
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: (...a: unknown[]) => incCounter(...(a as [string, Record<string, string>])),
  observe: jest.fn(),
  setGauge: jest.fn(),
}));
// Overrides go THROUGH apiCoreMock, never spread around it: a hand-rolled
// namespace drops every export it forgets, and they link as undefined.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({
    warn: (...a: unknown[]) => logWarn(...a),
    info: (...a: unknown[]) => logInfo(...a),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  // Pass-through: the assurance gate is exercised through its own suites.
  requireAssurance: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

/** The system tenant's well-known id — `isSystemOrgId`'s default. */
const SYSTEM_ORG = '000000000000000000000001';

// Each gate is a switch the test flips, so a refusal can be produced at the
// exact stage being asserted rather than by assembling a real token.
let authOutcome: 'pass' | 'reject' = 'pass';
let adminOutcome: 'pass' | 'reject' = 'pass';
/**
 * The org the token was minted in. NOT a switch like the two above: the org
 * gate is the REAL `requireSystemOrg` from api-core, exercised through the
 * claim it reads, because the point of these cases is that the gate is
 * claim-only — no lookup, nothing to stub.
 */
let activeOrg: string = SYSTEM_ORG;
jest.unstable_mockModule('../src/middleware/index.js', () => ({
  requireAuth: (req: any, res: any, next: () => void) => {
    if (authOutcome === 'reject') {
      return res.status(401).json({ success: false, statusCode: 401, message: 'Token invalid', code: 'TOKEN_INVALID' });
    }
    req.user = { sub: 'u-1', isSuperAdmin: true, organizationId: activeOrg };
    next();
  },
  requireSystemAdmin: (_req: any, res: any, next: () => void) => {
    if (adminOutcome === 'reject') {
      return res.status(403).json({ success: false, statusCode: 403, message: 'Forbidden: system administrator access required' });
    }
    next();
  },
}));

const { default: router } = await import('../src/routes/admin-console.js');

/**
 * Drive the router's single GET handler chain with a fake req/res.
 *
 * `reqHeaders` are the headers nginx sets on the `auth_request` subrequest —
 * `X-Original-URI` (which console path was asked for) and `X-PB-Console` (which
 * CLASS, where the URI cannot say). `consoleGate` reads them through
 * `req.header()`, so the fake implements it the way Express does: case-insensitive
 * over `req.headers`. Without that the gate threw `req.header is not a function`
 * and every case in this file failed for the wrong reason.
 */
async function call(reqHeaders: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string> }> {
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/' && l.route?.methods?.get);
  const handlers = layer.route.stack.map((s: any) => s.handle);
  const lower = Object.fromEntries(Object.entries(reqHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  const req: any = {
    method: 'GET',
    url: '/',
    originalUrl: '/admin/console-check',
    headers: lower,
    header: (name: string) => lower[name.toLowerCase()],
  };
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, headersSent: false };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.end = () => res;

  for (const h of handlers) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return { status: res.statusCode, headers: res.headers };
}

describe('GET /admin/console-check — refusal is explained', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authOutcome = 'pass';
    adminOutcome = 'pass';
    activeOrg = SYSTEM_ORG;
  });

  it('logs the CODE when the token itself is rejected', async () => {
    authOutcome = 'reject';
    const { status } = await call();

    expect(status).toBe(401);
    expect(logWarn).toHaveBeenCalledWith('Admin console check refused', expect.objectContaining({
      statusCode: 401,
      // The one field that separates "bad token" from "not an admin" from
      // "no second factor" — and the one nginx throws away.
      code: 'TOKEN_INVALID',
    }));
  });

  it('records the absence of a user, which itself narrows the cause', async () => {
    authOutcome = 'reject';
    await call();

    const [, fields] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    // No `userId` means the refusal happened BEFORE a token resolved to a
    // person; its presence would point at the admin/assurance gates instead.
    expect(fields.userId).toBeUndefined();
  });

  it('logs a system-admin refusal with the authenticated user', async () => {
    adminOutcome = 'reject';
    const { status } = await call();

    expect(status).toBe(403);
    expect(logWarn).toHaveBeenCalledWith('Admin console check refused', expect.objectContaining({
      statusCode: 403,
      userId: 'u-1',
    }));
  });

  it('returns the reason as a HEADER, which is all nginx can read', async () => {
    authOutcome = 'reject';
    const { headers } = await call();

    // `auth_request` discards the body, so this header is the only way the
    // gateway can tell the operator what to fix.
    expect(headers['X-PB-Deny-Reason']).toBe('TOKEN_INVALID');
  });

  it('falls back to the status when the gate sends no code', async () => {
    adminOutcome = 'reject';
    const { headers } = await call();

    // requireSystemAdmin's 403 carries no ErrorCode; the status still has to
    // reach nginx as something nameable.
    expect(headers['X-PB-Deny-Reason']).toBe('HTTP_403');
  });

  it('never puts the refusal MESSAGE in the header', async () => {
    authOutcome = 'reject';
    const { headers } = await call();

    // The header is attacker-visible through the console's error page, so it
    // must be a CODE — screaming snake case, no spaces — and never the
    // human-readable message, which is not public vocabulary. (Matching on
    // words like "invalid" would be wrong: TOKEN_INVALID contains one.)
    expect(headers['X-PB-Deny-Reason']).toMatch(/^[A-Z0-9_]+$/);
    expect(headers['X-PB-Deny-Reason']).not.toContain(' ');
  });

  it('says NOTHING when the check passes', async () => {
    const { status } = await call();

    expect(status).toBe(204);
    // nginx calls this on EVERY request to a fronted console; a line per pass
    // would drown the refusals this logging exists to surface.
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('refuses a platform admin whose token was minted in a TENANT org', async () => {
    activeOrg = '507f1f77bcf86cd799439011';
    const { status, headers } = await call();

    // The superadmin flag is not in question here — `requireAuth` set it. What
    // the consoles additionally require is which hat the operator is currently
    // wearing, because opening mongo-express from a tenant context begins a
    // datastore-wide session that reads, in the audit trail, as if it happened
    // inside that tenant.
    expect(status).toBe(403);
    expect(headers['X-PB-Deny-Reason']).toBe('SYSTEM_ORG_REQUIRED');
  });

  it('names the org gate in the log, so the operator knows to switch orgs', async () => {
    activeOrg = '507f1f77bcf86cd799439011';
    await call();

    // The ONE refusal on this route an operator can fix unaided — but only if
    // the reason survives, and `auth_request` discards the body.
    expect(logWarn).toHaveBeenCalledWith('Admin console check refused', expect.objectContaining({
      statusCode: 403,
      code: 'SYSTEM_ORG_REQUIRED',
      userId: 'u-1',
      isSuperAdmin: true,
    }));
  });

  it('refuses a token with no org claim at all, rather than defaulting open', async () => {
    activeOrg = undefined as unknown as string;
    const { status } = await call();

    // An absent `organizationId` must not read as "no org restriction". This is
    // the shape a malformed or hand-made token takes.
    expect(status).toBe(403);
  });

  it('admits a system-org admin — both conditions, not either', async () => {
    // The positive control for the pair. `adminOutcome` and `activeOrg` are
    // independent, so this is the only combination that reaches 204; the two
    // cases above cover admin-without-system-org, and the system-admin refusal
    // case above covers system-org-without-admin.
    activeOrg = SYSTEM_ORG;
    adminOutcome = 'pass';
    const { status } = await call();

    expect(status).toBe(204);
  });

  it('never logs the token or the authorization header', async () => {
    authOutcome = 'reject';
    await call();

    expect(JSON.stringify(logWarn.mock.calls)).not.toMatch(/authorization|bearer/i);
  });
});

describe('GET /admin/console-check — ADMITTED access is recorded', () => {
  // The gap this closes: refusals were logged and audited while an admitted
  // request recorded nothing at all, so "who opened pgAdmin, and when?" could
  // not be answered while every failed attempt could.
  beforeEach(() => {
    jest.clearAllMocks();
    authOutcome = 'pass';
    adminOutcome = 'pass';
    activeOrg = SYSTEM_ORG;
  });

  it.each([
    ['database', 'database'],
    ['observability', 'observability'],
    ['objectstore', 'objectstore'],
  ])('counts a %s console admission, labelled by class', async (header, expected) => {
    const { status } = await call({ 'X-PB-Console': header });
    expect(status).toBe(204);
    expect(incCounter).toHaveBeenCalledWith('admin_console_access_total', { console_class: expected });
  });

  it('labels an unrecognised console rather than omitting the label', async () => {
    // A console added to nginx and named nowhere still gates on the flag, and
    // its access must still be countable — otherwise the one path most likely
    // to be misconfigured is the one with no signal.
    const { status } = await call({ 'X-Original-URI': '/something-new/' });
    expect(status).toBe(204);
    expect(incCounter).toHaveBeenCalledWith('admin_console_access_total', { console_class: 'unrecognised' });
  });

  it('logs who was admitted, so the gateway log can be correlated', async () => {
    await call({ 'X-PB-Console': 'database' });
    expect(logInfo).toHaveBeenCalledWith('Admin console access admitted', expect.objectContaining({
      consoleClass: 'database', userId: 'u-1',
    }));
  });

  it('carries NO per-user or per-URI label on the metric', async () => {
    // Cardinality: three bounded classes. A user id would be a series per
    // operator and a URI unbounded; the log line carries the user instead.
    await call({ 'X-PB-Console': 'database' });
    expect(Object.keys(incCounter.mock.calls[0]?.[1] ?? {})).toEqual(['console_class']);
  });

  it('still admits the request when the counter throws', async () => {
    // A metrics misconfiguration must not turn every admin console into a 500:
    // this handler runs on EVERY request the gateway proxies.
    incCounter.mockImplementationOnce(() => { throw new Error('Metrics registry not set'); });
    const { status } = await call({ 'X-PB-Console': 'database' });
    expect(status).toBe(204);
  });
});
