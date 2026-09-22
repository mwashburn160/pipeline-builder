// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin-ecosystem governance gate (docs/runbooks/ecosystem-moderation.md):
 * only a caller whose ACTIVE org is the system org, holding the
 * system-org-only permission, on an MFA-grade human session, may exercise
 * ecosystem-governance authority. Also pins the route-table governance check
 * (`findSystemOrgGuardViolations`) against fixtures, so the utility the service
 * route-coverage tests rely on is itself proven to bite.
 */

import type { AnyFn } from '../src/testing/any-fn.js';
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { SYSTEM_ORG_ID } from '../src/middleware/system-org.js';
import { requireAssurance } from '../src/middleware/assurance.js';
import { requireAuth } from '../src/middleware/auth.js';
import { requirePermission, setAuthzDenialAuditor, type AuthzDenialInfo } from '../src/middleware/permission-gates.js';
import { isSystemOrgRequest, requireEcosystemPermission, requireSystemOrg } from '../src/middleware/ecosystem-guard.js';
import { audited, buildRouteTable, type RouteTableEntry } from '../src/middleware/route-table.js';
import { findSystemOrgGuardViolations } from '../src/testing/route-coverage.js';
import { confinePermissionsToOrg, resolveUserPermissions } from '../src/types/permissions.js';

const TENANT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const now = () => Math.floor(Date.now() / 1000);
const human = (over: Record<string, unknown> = {}) => ({
  principalType: 'user',
  token_use: 'access',
  sub: 'u1',
  aal: 2,
  auth_time: now(),
  organizationId: SYSTEM_ORG_ID,
  permissions: ['plugins:moderate'],
  ...over,
});

function mockReq(user: Record<string, unknown> | undefined, method = 'POST'): Request {
  return { headers: {}, method, url: '/x', originalUrl: '/x', user } as unknown as Request;
}

type MockRes = Response & { _status: number; _json: { code?: string } | null };
function mockRes(): MockRes {
  const res = {
    _status: 0,
    _json: null as { code?: string } | null,
    status(code: number) { res._status = code; return res; },
    json(body: unknown) { res._json = body as { code?: string }; return res; },
  };
  return res as unknown as MockRes;
}

/** Run a middleware chain the way Express would; stop at the first refusal. */
function runChain(chain: RequestHandler[], user: Record<string, unknown> | undefined): { passed: boolean; res: MockRes } {
  const req = mockReq(user);
  const res = mockRes();
  for (const mw of chain) {
    let advanced = false;
    (mw as (req: Request, res: Response, next: NextFunction) => void)(req, res, () => { advanced = true; });
    if (!advanced) return { passed: false, res };
  }
  return { passed: true, res };
}

afterEach(() => setAuthzDenialAuditor(undefined));

describe('requireSystemOrg', () => {
  it('admits a caller whose active org is the system org', () => {
    const next = jest.fn<AnyFn>();
    requireSystemOrg(mockReq(human()), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('refuses a tenant-org token with 403 SYSTEM_ORG_REQUIRED and records an authz denial', () => {
    const denials: AuthzDenialInfo[] = [];
    setAuthzDenialAuditor((d) => denials.push(d));
    const res = mockRes();
    const next = jest.fn<AnyFn>();
    requireSystemOrg(mockReq(human({ organizationId: TENANT })), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._json?.code).toBe('SYSTEM_ORG_REQUIRED');
    expect(denials).toEqual([expect.objectContaining({ required: 'system-org', orgId: TENANT })]);
  });

  it('refuses a SUPERADMIN acting from a tenant org — governance happens from the system org', () => {
    const res = mockRes();
    requireSystemOrg(mockReq(human({ organizationId: TENANT, isSuperAdmin: true })), res, jest.fn<AnyFn>());
    expect(res._json?.code).toBe('SYSTEM_ORG_REQUIRED');
  });

  it('never matches an org merely NAMED "system" (id comparison only)', () => {
    expect(isSystemOrgRequest(mockReq(human({ organizationId: TENANT, organizationName: 'system' })))).toBe(false);
    const res = mockRes();
    requireSystemOrg(mockReq(human({ organizationId: 'system' })), res, jest.fn<AnyFn>());
    expect(res._status).toBe(403);
  });

  it('401s an unauthenticated request', () => {
    const res = mockRes();
    requireSystemOrg(mockReq(undefined), res, jest.fn<AnyFn>());
    expect(res._status).toBe(401);
  });
});

describe('requireEcosystemPermission', () => {
  const chain = requireEcosystemPermission('plugins:moderate');

  it('admits a system-org Ecosystem Manager on an MFA-grade session', () => {
    expect(runChain(chain, human()).passed).toBe(true);
  });

  it('refuses the same person with a token minted in a tenant org', () => {
    const { passed, res } = runChain(chain, human({ organizationId: TENANT }));
    expect(passed).toBe(false);
    expect(res._json?.code).toBe('SYSTEM_ORG_REQUIRED');
  });

  it('refuses a system-org member without the permission', () => {
    const { passed, res } = runChain(chain, human({ permissions: ['plugins:read'] }));
    expect(passed).toBe(false);
    expect(res._json?.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('refuses a single-factor session (enrol prompt, not a sign-out)', () => {
    const { res } = runChain(chain, human({ aal: 1 }));
    expect(res._status).toBe(401);
    expect(res._json?.code).toBe('MFA_REQUIRED');
  });

  it('refuses machine credentials outright, even in the system org with the permission', () => {
    expect(runChain(chain, human({ token_use: 'api_key' })).res._json?.code).toBe('HUMAN_SESSION_REQUIRED');
    expect(runChain(chain, human({ principalType: 'service_account', token_use: 'api_key' })).res._json?.code).toBe('HUMAN_SESSION_REQUIRED');
  });

  it('admits a superadmin in the system org via the implicit-all permission', () => {
    expect(runChain(chain, human({ permissions: [], isSuperAdmin: true })).passed).toBe(true);
  });

  it('refuses to wrap a tenant (org-assignable) permission — always a wiring mistake', () => {
    expect(() => requireEcosystemPermission('plugins:publish')).toThrow(/system-org-only/);
    expect(() => requireEcosystemPermission()).toThrow(/at least one/);
  });

  it('puts system org + permission + aal2 on the route table', () => {
    const app = express();
    const r = Router();
    r.post('/requests/:id/approve', requireAuth, requireEcosystemPermission('plugins:moderate', 'publishers:verify'), audited('plugin.request.approve'), (_q: Request, s: Response) => { s.end(); });
    app.use('/ecosystem', r);
    const [row] = buildRouteTable(app);
    expect(row.systemOrg).toBe(true);
    expect(row.minAssurance).toBe(2);
    expect(row.permissions).toEqual([{ mode: 'any', permissions: ['plugins:moderate', 'publishers:verify'], allowService: false }]);
    expect(findSystemOrgGuardViolations([row])).toEqual([]);
  });
});

describe('findSystemOrgGuardViolations (governance check self-test)', () => {
  const noop: RequestHandler = (_q, s) => { s.end(); };
  function tableOf(build: (r: Router) => void): RouteTableEntry[] {
    const app = express();
    const r = Router();
    build(r);
    app.use('/', r);
    return buildRouteTable(app);
  }

  it('passes a table with no governance routes (bites only once one exists)', () => {
    const table = tableOf((r) => {
      r.get('/plugins', requireAuth, requirePermission('plugins:read'), noop);
      r.post('/plugins', requireAuth, requirePermission('plugins:write'), audited('plugin.create'), noop);
    });
    expect(findSystemOrgGuardViolations(table)).toEqual([]);
  });

  it('flags a moderation route gated by a bare requirePermission (no system-org guard, no aal2)', () => {
    const table = tableOf((r) => { r.post('/moderate', requireAuth, requirePermission('plugins:moderate'), noop); });
    const v = findSystemOrgGuardViolations(table);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatch(/POST \/moderate: .*without requireSystemOrg/);
    expect(v[1]).toMatch(/MFA-grade/);
  });

  it('flags a route that has aal2 but forgot the system-org guard', () => {
    const table = tableOf((r) => { r.post('/verify', requireAuth, requirePermission('publishers:verify'), requireAssurance({ minAssurance: 2 }), noop); });
    expect(findSystemOrgGuardViolations(table)).toEqual([expect.stringMatching(/without requireSystemOrg/)]);
  });

  it('flags a route that has the system-org guard but no aal2', () => {
    const table = tableOf((r) => { r.post('/verify', requireAuth, requireSystemOrg, requirePermission('publishers:verify'), noop); });
    expect(findSystemOrgGuardViolations(table)).toEqual([expect.stringMatching(/MFA-grade/)]);
  });

  it('flags a system-org-only permission hidden inside an any-of with a tenant permission', () => {
    const table = tableOf((r) => { r.get('/mixed', requireAuth, requirePermission('plugins:read', 'plugins:moderate'), noop); });
    expect(findSystemOrgGuardViolations(table)).toHaveLength(2);
  });

  it('sees a guard applied at the router mount', () => {
    const app = express();
    const r = Router();
    r.post('/x', audited('plugin.request.approve'), noop);
    app.use('/eco', requireAuth, requireEcosystemPermission('plugins:moderate'), r);
    expect(findSystemOrgGuardViolations(buildRouteTable(app))).toEqual([]);
  });
});

describe('confinePermissionsToOrg (token issue)', () => {
  it('drops system-org-only permissions outside the system org — even a superadmin\'s implicit-all', () => {
    const all = resolveUserPermissions([], true);
    const confined = confinePermissionsToOrg(all, false);
    expect(confined).not.toContain('plugins:moderate');
    expect(confined).not.toContain('publishers:verify');
    expect(confined).toContain('plugins:publish');
    expect(confined).toHaveLength(all.length - 2);
  });

  it('keeps them in the system org', () => {
    expect(confinePermissionsToOrg(['plugins:read', 'plugins:moderate'], true)).toEqual(['plugins:read', 'plugins:moderate']);
  });

  it('strips a stray grant carried into a tenant org', () => {
    expect(confinePermissionsToOrg(['plugins:read', 'publishers:verify'], false)).toEqual(['plugins:read']);
  });
});
