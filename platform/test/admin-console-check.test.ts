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
// Overrides go THROUGH apiCoreMock, never spread around it: a hand-rolled
// namespace drops every export it forgets, and they link as undefined.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ warn: (...a: unknown[]) => logWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
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

/** Drive the router's single GET handler chain with a fake req/res. */
async function call(): Promise<{ status: number; headers: Record<string, string> }> {
  const layer = (router.stack as any[]).find((l) => l.route?.path === '/' && l.route?.methods?.get);
  const handlers = layer.route.stack.map((s: any) => s.handle);
  const req: any = { method: 'GET', url: '/', originalUrl: '/admin/console-check', headers: {} };
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
