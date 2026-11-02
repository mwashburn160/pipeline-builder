// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring test for the alert-silence endpoints.
 *
 * Creating or deleting a silence SUPPRESSES an org's alerts (detection-evasion),
 * so those mutations must carry `requirePermission('observability:write')` just
 * like every sibling alerting mutation — a plain member holding only
 * `observability:read` must NOT reach the handler. The silence LIST/read route
 * stays READ-level — `observability:read`, never `:write`. This test inspects
 * the router stack so a regression that drops (or downgrades) the write-gate
 * fails loudly.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// requireAuth stub — tagged so we can tell it apart from requirePermission.
const requireAuthStub: any = (_req: unknown, _res: unknown, next: () => void) => next();
requireAuthStub.__mw = 'requireAuth';


// requirePermission stub — returns a middleware tagged with the perms it gates,
// so the stack assertion can identify the write-gate on a route.
// Spread the real module: the routes file transitively imports the Loki log
// controller, which uses `createLogger` and friends. An explicit allow-list
// breaks this suite every time the route module reaches for another export.
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  ...actualApiCore,
  // The restore routes import it; the silence-route assertions don't inspect it.
  requireStepUp: (_req: unknown, _res: unknown, next: () => void) => next(),
  // Route-table audit declaration — a pass-through no-op here; the coverage test
  // (test/route-coverage.test.ts) is what asserts on the declared actions.
  audited: (..._actions: string[]) => Object.assign(
    (_req: unknown, _res: unknown, next: () => void) => next(),
    { __mw: 'audited' },
  ),
  requirePermission: (...perms: string[]) => {
    const mw: any = (req: any, res: any, next: () => void) => {
      const has = req?.user?.isSuperAdmin === true
        || (Array.isArray(req?.user?.permissions) && perms.some((p) => req.user.permissions.includes(p)));
      if (has) return next();
      res.status(403).json({ success: false, message: 'INSUFFICIENT_PERMISSIONS' });
    };
    mw.__mw = 'requirePermission';
    mw.__perms = perms;
    return mw;
  },
  // `requireSystemOrgPermission` returns the CHAIN (requireSystemOrg + the
  // permission + aal2) as an array, which the route spreads. Tagged member by
  // member so a route assertion can name the part it cares about, and so the
  // permission one still carries `__perms`.
  requireSystemOrgPermission: (...perms: string[]) => {
    const org: any = (_req: unknown, _res: unknown, next: () => void) => next();
    org.__mw = 'requireSystemOrg';
    const perm: any = (_req: unknown, _res: unknown, next: () => void) => next();
    perm.__mw = 'requirePermission';
    perm.__perms = perms;
    const aal: any = (_req: unknown, _res: unknown, next: () => void) => next();
    aal.__mw = 'requireAssurance';
    return [org, perm, aal];
  },
}));

// requireSystemAdmin stub — the two cross-tenant reads (/alert-destinations/all,
// /alert-rules/materialized.yml) mirror their handlers' sysadmin gate at the route.
const requireSystemAdminStub: any = (_req: unknown, _res: unknown, next: () => void) => next();
requireSystemAdminStub.__mw = 'requireSystemAdmin';

jest.unstable_mockModule('../src/middleware/index.js', () => ({
  requireAuth: requireAuthStub,
  requireSystemAdmin: requireSystemAdminStub,
}));

// Handler stubs — the router only needs referenceable functions.
const handler = (name: string) => Object.assign((_req: unknown, res: any) => res?.end?.(), { __handler: name });

jest.unstable_mockModule('../src/controllers/alert-destinations.js', () => ({
  listAlertDestinations: handler('listAlertDestinations'),
  listAllAlertDestinations: handler('listAllAlertDestinations'),
  listDeletedAlertDestinations: handler('listDeletedAlertDestinations'),
  createAlertDestination: handler('createAlertDestination'),
  updateAlertDestination: handler('updateAlertDestination'),
  deleteAlertDestination: handler('deleteAlertDestination'),
  restoreAlertDestination: handler('restoreAlertDestination'),
  purgeAlertDestination: handler('purgeAlertDestination'),
  testAlertDestination: handler('testAlertDestination'),
  alertWebhook: handler('alertWebhook'),
}));

jest.unstable_mockModule('../src/controllers/alert-rules.js', () => ({
  listAlertRules: handler('listAlertRules'),
  listDeletedAlertRules: handler('listDeletedAlertRules'),
  createAlertRule: handler('createAlertRule'),
  updateAlertRule: handler('updateAlertRule'),
  deleteAlertRule: handler('deleteAlertRule'),
  restoreAlertRule: handler('restoreAlertRule'),
  purgeAlertRule: handler('purgeAlertRule'),
  materializeAlertRules: handler('materializeAlertRules'),
}));

jest.unstable_mockModule('../src/observability/controller.js', () => ({
  observabilityQuery: handler('observabilityQuery'),
  observabilityAuditQuery: handler('observabilityAuditQuery'),
  observabilityCatalog: handler('observabilityCatalog'),
  observabilityAlerts: handler('observabilityAlerts'),
  observabilitySilencesList: handler('observabilitySilencesList'),
  observabilitySilenceCreate: handler('observabilitySilenceCreate'),
  observabilitySilenceDelete: handler('observabilitySilenceDelete'),
}));

// The THREE autoscaling controllers, stubbed for the same reason as their
// siblings: each reads platform config, so importing the router for real would
// construct it — and this suite asserts the ROUTE STACK, not configuration.
//
// Construction is not merely wasteful, it THROWS: config's module body calls
// requireEncryptionKey(), so an unmocked controller here fails the whole suite
// at LOAD with "SECRET_ENCRYPTION_KEY is required in production" — a message
// that points at secrets rather than at the missing mock. Every controller the
// router imports needs an entry; adding a route to observability.ts means
// adding one here.
jest.unstable_mockModule('../src/controllers/pvc-autoexpand.js', () => ({
  pvcAutoExpandWebhook: handler('pvcAutoExpandWebhook'),
}));

jest.unstable_mockModule('../src/controllers/postgres-rung.js', () => ({
  postgresRungWebhook: handler('postgresRungWebhook'),
}));

jest.unstable_mockModule('../src/controllers/oncall.js', () => ({
  oncallWebhook: handler('oncallWebhook'),
  // Every export the router imports. A namespace mock REPLACES the module, so
  // one it forgets links as `undefined` and the whole suite fails to load
  // naming the export rather than the route — which is what happened here.
  oncallAckWebhook: handler('oncallAckWebhook'),
  oncallStatus: handler('oncallStatus'),
  oncallTest: handler('oncallTest'),
}));

jest.unstable_mockModule('../src/controllers/node-disk-autoexpand.js', () => ({
  nodeDiskAutoExpandWebhook: handler('nodeDiskAutoExpandWebhook'),
}));

// The Loki log controller is stubbed like its siblings above: this suite asserts
// the ROUTE STACK (which gate sits on which path), not handler behaviour, and the
// real module pulls platform config in at import time.
jest.unstable_mockModule('../src/observability/log-controller.js', () => ({
  logSearch: handler('logSearch'),
  logVolume: handler('logVolume'),
  logContext: handler('logContext'),
  logRaw: handler('logRaw'),
  logExport: handler('logExport'),
}));

const router = (await import('../src/routes/observability.js')).default as any;

/** Find the registered route layer matching a method + path predicate. */
function findRoute(method: string, pathPred: (p: string) => boolean) {
  return router.stack.find(
    (l: any) => l.route && l.route.methods?.[method] && pathPred(l.route.path),
  );
}

/** The middleware/handler function list for a route layer. */
function routeHandlers(layer: any): any[] {
  return (layer.route.stack as any[]).map((s) => s.handle);
}

describe('observability silence routes — write-gate wiring', () => {
  it('POST /silences carries requirePermission(observability:write)', () => {
    const layer = findRoute('post', (p) => p === '/silences');
    expect(layer).toBeDefined();
    const gate = routeHandlers(layer).find((h) => h.__mw === 'requirePermission');
    expect(gate).toBeDefined();
    expect(gate.__perms).toContain('observability:write');
  });

  it('DELETE /silences/:id carries requirePermission(observability:write)', () => {
    const layer = findRoute('delete', (p) => p.startsWith('/silences/'));
    expect(layer).toBeDefined();
    const gate = routeHandlers(layer).find((h) => h.__mw === 'requirePermission');
    expect(gate).toBeDefined();
    expect(gate.__perms).toContain('observability:write');
  });

  it('a member lacking observability:write is rejected by the create gate (403)', () => {
    const layer = findRoute('post', (p) => p === '/silences');
    const gate = routeHandlers(layer).find((h) => h.__mw === 'requirePermission');
    const req: any = { user: { permissions: ['observability:read'] } };
    let status = 0;
    const res: any = { status: (n: number) => { status = n; return res; }, json: () => res };
    const next = jest.fn();
    gate(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toBe(403);
  });

  it('the silence LIST route stays read-level (observability:read, never :write)', () => {
    const layer = findRoute('get', (p) => p === '/silences');
    expect(layer).toBeDefined();
    const gate = routeHandlers(layer).find((h) => h.__mw === 'requirePermission');
    expect(gate).toBeDefined();
    expect(gate.__perms).toEqual(['observability:read']);
  });

  // The two cross-tenant reads moved off the superadmin FLAG onto `platform:read`
  // — a Platform Operator read — which `requireSystemOrgPermission` pairs with
  // requireSystemOrg and an MFA-grade session. Asserting the WHOLE chain, not one
  // member: a route that lost the org check or the assurance level would still
  // satisfy a single-name assertion, and those two are what keep a system-org-only
  // permission from being exercised from a tenant-scoped session.
  it('the cross-tenant reads carry the full system-org permission chain', () => {
    for (const path of ['/alert-destinations/all', '/alert-rules/materialized.yml']) {
      const layer = findRoute('get', (p) => p === path);
      expect(layer).toBeDefined();
      const mws = routeHandlers(layer).map((h) => h.__mw);
      expect(mws).toEqual(expect.arrayContaining(['requireSystemOrg', 'requirePermission', 'requireAssurance']));
      const gate = routeHandlers(layer).find((h) => h.__mw === 'requirePermission');
      expect(gate.__perms).toEqual(['platform:read']);
    }
  });
});
