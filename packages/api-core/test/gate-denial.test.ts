// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every tagged gate actually REFUSES an unqualified caller.
 *
 * WHY. `tagRouteGate(fn, { kind: 'permission', … })` attaches metadata that the
 * route table publishes and that the frontend's `can(...)` parity tests, the
 * route-coverage rules and `docs/permission-contract.md` all read. Every one of
 * those consumers takes the tag as TRUE — nothing checked that a gate tagged
 * `{ kind: 'systemAdmin' }` actually stops a non-sysadmin. A gate whose body was
 * gutted (an early `return next()`, an inverted check) would keep its tag, keep
 * its route-table entry, keep its contract row, and pass every parity test, while
 * admitting everyone.
 *
 * So for each gate this asserts BOTH halves, as real Express middleware:
 *   - an unqualified caller gets 401/403 and `next` is NEVER called;
 *   - a qualified caller passes.
 * Plus: the metadata the tag advertises matches the gate that was built.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import {
  requireAllPermissions,
  requireFeature,
  requireInternalService,
  requirePermission,
  requirePermissionOrService,
  requireServicePrincipal,
  requireSystemAdmin,
} from '../src/middleware/auth.js';
import { getRouteGates } from '../src/middleware/route-table.js';
import type { Permission } from '../src/types/permissions.js';

type User = Partial<{
  sub: string;
  isSuperAdmin: boolean;
  permissions: string[];
  principalType: string;
  features: string[];
  organizationId: string;
}>;

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) { this.statusCode = code; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader() { return this; },
  };
  return res as unknown as Response & { statusCode: number; body: { code?: string; message?: string } };
}

// `originalUrl`/`url` are load-bearing: requireInternalService builds a metric
// label from them on the refusal path.
const reqAs = (user?: User): Request =>
  ({ user, method: 'POST', path: '/x', url: '/internal/x', originalUrl: '/internal/x', headers: {} } as unknown as Request);

/** Run a gate and report what happened — did it pass, or refuse with what status? */
function run(gate: (r: Request, s: Response, n: NextFunction) => void, user?: User) {
  const res = makeRes();
  const next = jest.fn();
  gate(reqAs(user), res, next as unknown as NextFunction);
  return { passed: next.mock.calls.length > 0, status: res.statusCode, body: res.body };
}

const MEMBER: User = { sub: 'u1', organizationId: 'org-1', permissions: [] };
const SUPERADMIN: User = { sub: 'root', isSuperAdmin: true };
const SERVICE: User = { sub: 'service:quota', principalType: 'service' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('requirePermission (any-of)', () => {
  const gate = requirePermission('pipelines:write' as Permission);

  it('401s an anonymous caller without calling next', () => {
    const r = run(gate, undefined);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
  });

  it('403s a caller who holds none of the permissions', () => {
    const r = run(gate, MEMBER);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('403s a caller holding a DIFFERENT permission', () => {
    const r = run(gate, { ...MEMBER, permissions: ['pipelines:read'] });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  it('passes a caller holding the permission', () => {
    expect(run(gate, { ...MEMBER, permissions: ['pipelines:write'] }).passed).toBe(true);
  });

  it('passes a superadmin (implicit-all)', () => {
    expect(run(gate, SUPERADMIN).passed).toBe(true);
  });

  it('does NOT admit a bare service principal', () => {
    // requirePermissionOrService is the gate that admits services; this one
    // must not, or every `+svc` distinction in the route table is fiction.
    expect(run(gate, SERVICE).passed).toBe(false);
  });

  it('advertises what it enforces', () => {
    expect(getRouteGates(gate)).toEqual([
      { kind: 'permission', mode: 'any', permissions: ['pipelines:write'] },
    ]);
  });
});

describe('requireAllPermissions (all-of)', () => {
  const gate = requireAllPermissions('pipelines:write' as Permission, 'plugins:write' as Permission);

  it('401s an anonymous caller', () => {
    expect(run(gate, undefined).status).toBe(401);
  });

  it('403s a caller holding only SOME of them — the any/all distinction', () => {
    const r = run(gate, { ...MEMBER, permissions: ['pipelines:write'] });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
    // The refusal names what is missing, not what was required.
    expect(r.body.message).toContain('plugins:write');
    expect(r.body.message).not.toContain('pipelines:write');
  });

  it('passes a caller holding every one', () => {
    expect(run(gate, { ...MEMBER, permissions: ['pipelines:write', 'plugins:write'] }).passed).toBe(true);
  });

  it('passes a superadmin', () => {
    expect(run(gate, SUPERADMIN).passed).toBe(true);
  });

  it('advertises mode "all"', () => {
    expect(getRouteGates(gate)[0]).toMatchObject({ kind: 'permission', mode: 'all' });
  });
});

describe('requirePermissionOrService', () => {
  const gate = requirePermissionOrService('quota:read' as Permission);

  it('401s an anonymous caller', () => {
    expect(run(gate, undefined).status).toBe(401);
  });

  it('403s a user holding neither the permission nor a service principal', () => {
    expect(run(gate, MEMBER).status).toBe(403);
  });

  it('passes a service principal that holds NO permissions (the whole point)', () => {
    expect(run(gate, SERVICE).passed).toBe(true);
  });

  it('passes a user holding the permission', () => {
    expect(run(gate, { ...MEMBER, permissions: ['quota:read'] }).passed).toBe(true);
  });

  it('advertises allowService, which the route table publishes as `+svc`', () => {
    expect(getRouteGates(gate)[0]).toMatchObject({ allowService: true });
  });
});

describe('requireSystemAdmin', () => {
  it('403s an ordinary member', () => {
    const r = run(requireSystemAdmin, MEMBER);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('403s an anonymous caller (no user ⇒ not a sysadmin)', () => {
    expect(run(requireSystemAdmin, undefined).passed).toBe(false);
  });

  it('403s a caller who merely holds a lot of permissions', () => {
    // Platform-admin authority is the `isSuperAdmin` claim ALONE — it is not
    // approximable by accumulating org permissions.
    expect(run(requireSystemAdmin, { ...MEMBER, permissions: ['org:manage', 'members:manage'] }).passed).toBe(false);
  });

  it('403s a SERVICE principal', () => {
    expect(run(requireSystemAdmin, SERVICE).passed).toBe(false);
  });

  it('passes a superadmin', () => {
    expect(run(requireSystemAdmin, SUPERADMIN).passed).toBe(true);
  });

  it('is tagged systemAdmin', () => {
    expect(getRouteGates(requireSystemAdmin)).toEqual([{ kind: 'systemAdmin' }]);
  });
});

describe('requireServicePrincipal', () => {
  it('403s a user token', () => {
    const r = run(requireServicePrincipal, MEMBER);
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  it('403s a SUPERADMIN user token — "privileged human" is not a service', () => {
    expect(run(requireServicePrincipal, SUPERADMIN).passed).toBe(false);
  });

  it('403s an anonymous caller', () => {
    expect(run(requireServicePrincipal, undefined).passed).toBe(false);
  });

  it('passes a service principal', () => {
    expect(run(requireServicePrincipal, SERVICE).passed).toBe(true);
  });

  it('is tagged servicePrincipal', () => {
    expect(getRouteGates(requireServicePrincipal)).toEqual([{ kind: 'servicePrincipal' }]);
  });
});

describe('requireInternalService (the /internal/* gate)', () => {
  const gate = requireInternalService({ callers: ['quota', 'billing'] });

  it('403s every user token, superadmin included', () => {
    expect(run(gate, MEMBER).passed).toBe(false);
    expect(run(gate, SUPERADMIN).passed).toBe(false);
  });

  it('403s a service whose NAME is not in the caller list', () => {
    // The caller list is the allow-list the mesh policy mirrors; a service
    // outside it must be refused even though it is a valid service principal.
    expect(run(gate, { sub: 'service:reporting', principalType: 'service' }).passed).toBe(false);
  });

  it('passes a service named in the caller list', () => {
    expect(run(gate, { sub: 'service:quota', principalType: 'service' }).passed).toBe(true);
  });

  it('advertises its caller list, which the mesh policy is checked against', () => {
    // It carries TWO tags: `servicePrincipal` (so generic "is it gated?" checks
    // see it) plus `internalService` with the allow-list the mesh mirrors.
    expect(getRouteGates(gate)).toEqual(expect.arrayContaining([
      { kind: 'servicePrincipal' },
      { kind: 'internalService', callers: ['quota', 'billing'] },
    ]));
  });
});

describe('requireFeature (paid entitlement)', () => {
  const gate = requireFeature('sso');

  it('401s an anonymous caller', () => {
    expect(run(gate, undefined).status).toBe(401);
  });

  it('403s a caller whose token carries no such feature', () => {
    const r = run(gate, { ...MEMBER, features: ['advanced_reporting'] });
    expect(r.passed).toBe(false);
    expect(r.status).toBe(403);
  });

  it('403s a caller with NO features array at all', () => {
    expect(run(gate, MEMBER).passed).toBe(false);
  });

  it('passes a caller entitled to the feature', () => {
    expect(run(gate, { ...MEMBER, features: ['sso'] }).passed).toBe(true);
  });

  it('passes a superadmin regardless of the token\'s features', () => {
    expect(run(gate, { ...SUPERADMIN, features: [] }).passed).toBe(true);
  });

  it('advertises the feature it gates', () => {
    expect(getRouteGates(gate)).toEqual([{ kind: 'feature', feature: 'sso' }]);
  });
});

describe('no gate admits an anonymous caller', () => {
  // A sweep, so a gate added later is covered by at least this much.
  const gates: Array<[string, (r: Request, s: Response, n: NextFunction) => void]> = [
    ['requirePermission', requirePermission('pipelines:write' as Permission)],
    ['requireAllPermissions', requireAllPermissions('pipelines:write' as Permission)],
    ['requirePermissionOrService', requirePermissionOrService('quota:read' as Permission)],
    ['requireSystemAdmin', requireSystemAdmin],
    ['requireServicePrincipal', requireServicePrincipal],
    ['requireInternalService', requireInternalService({ callers: ['quota'] })],
    ['requireFeature', requireFeature('sso')],
  ];

  it.each(gates)('%s refuses a request with no user', (_name, gate) => {
    const r = run(gate, undefined);
    expect(r.passed).toBe(false);
    expect([401, 403]).toContain(r.status);
  });
});
