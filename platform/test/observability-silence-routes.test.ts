// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-wiring test for the alert-silence endpoints.
 *
 * Creating or deleting a silence SUPPRESSES an org's alerts (detection-evasion),
 * so those mutations must carry `requirePermission('observability:write')` just
 * like every sibling alerting mutation — a plain member holding only
 * `observability:read` must NOT reach the handler. The silence LIST/read route
 * stays read-level (requireAuth only). This test inspects the router stack so a
 * regression that drops the write-gate fails loudly.
 */

import { jest, describe, it, expect } from '@jest/globals';

// requireAuth stub — tagged so we can tell it apart from requirePermission.
const requireAuthStub: any = (_req: unknown, _res: unknown, next: () => void) => next();
requireAuthStub.__mw = 'requireAuth';

// requirePermission stub — returns a middleware tagged with the perms it gates,
// so the stack assertion can identify the write-gate on a route.
jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
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
}));

jest.unstable_mockModule('../src/middleware/index.js', () => ({ requireAuth: requireAuthStub }));

// Handler stubs — the router only needs referenceable functions.
const handler = (name: string) => Object.assign((_req: unknown, res: any) => res?.end?.(), { __handler: name });

jest.unstable_mockModule('../src/controllers/alert-destinations.js', () => ({
  listAlertDestinations: handler('listAlertDestinations'),
  listAllAlertDestinations: handler('listAllAlertDestinations'),
  createAlertDestination: handler('createAlertDestination'),
  updateAlertDestination: handler('updateAlertDestination'),
  deleteAlertDestination: handler('deleteAlertDestination'),
  testAlertDestination: handler('testAlertDestination'),
  alertWebhook: handler('alertWebhook'),
}));

jest.unstable_mockModule('../src/controllers/alert-rules.js', () => ({
  listAlertRules: handler('listAlertRules'),
  createAlertRule: handler('createAlertRule'),
  updateAlertRule: handler('updateAlertRule'),
  deleteAlertRule: handler('deleteAlertRule'),
  materializeAlertRules: handler('materializeAlertRules'),
}));

jest.unstable_mockModule('../src/observability/controller.js', () => ({
  observabilityQuery: handler('observabilityQuery'),
  observabilityLogs: handler('observabilityLogs'),
  observabilityCatalog: handler('observabilityCatalog'),
  observabilityAlerts: handler('observabilityAlerts'),
  observabilitySilencesList: handler('observabilitySilencesList'),
  observabilitySilenceCreate: handler('observabilitySilenceCreate'),
  observabilitySilenceDelete: handler('observabilitySilenceDelete'),
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

  it('the silence LIST route stays read-level (no requirePermission gate)', () => {
    const layer = findRoute('get', (p) => p === '/silences');
    expect(layer).toBeDefined();
    const gate = routeHandlers(layer).find((h) => h.__mw === 'requirePermission');
    expect(gate).toBeUndefined();
  });
});
