// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The route table is what proves permission/audit coverage per service, so its
 * resolution rules are pinned here: mount-level guards must reach the routes
 * they actually run for (and no others), nested routers must compose, and the
 * gate metadata on every api-core gate must survive into the table.
 */

import { describe, it, expect } from '@jest/globals';
import express, { Router } from 'express';
import {
  audited,
  buildRouteTable,
  isWriteMethod,
  requireAllPermissions,
  requireAuth,
  requireFeature,
  requireInternalService,
  requirePermission,
  requirePermissionOrService,
  requireServicePrincipal,
  requireStepUp,
  requireSystemAdmin,
  summarizeRouteTable,
  tagRouteGate,
  type RouteTableEntry,
} from '../src/index.js';
import {
  findInternalRouteViolations,
  findRouteCoverageViolations,
  type RouteCoverageException,
} from '../src/testing/route-coverage.js';

const noop = (_req: unknown, _res: unknown, _next: unknown): void => {};

function entry(table: RouteTableEntry[], method: string, path: string): RouteTableEntry {
  const found = table.find((e) => e.method === method && e.path === path);
  if (!found) throw new Error(`no ${method} ${path} in [${table.map((e) => `${e.method} ${e.path}`).join(', ')}]`);
  return found;
}

describe('buildRouteTable', () => {
  it('resolves mount-level guards onto the routes of the mounted router', () => {
    const app = express();
    const router = Router();
    router.get('/', noop);
    router.post('/', audited('pipeline.create'), noop);
    app.use('/pipelines', requireAuth, requirePermission('pipelines:write'), router);

    const table = buildRouteTable(app);
    expect(table.map((e) => `${e.method} ${e.path}`)).toEqual(['GET /pipelines', 'POST /pipelines']);
    const post = entry(table, 'POST', '/pipelines');
    expect(post.auth).toBe(true);
    expect(post.permissions).toEqual([{ mode: 'any', permissions: ['pipelines:write'], allowService: false }]);
    expect(post.audit).toEqual(['pipeline.create']);
  });

  it('does NOT leak a guard mounted on a different prefix', () => {
    const app = express();
    const reads = Router();
    reads.get('/list', noop);
    const writes = Router();
    writes.post('/new', noop);
    app.use('/x/list', requirePermission('pipelines:read'), (_req, _res, next) => next());
    app.use('/x', reads);
    app.use('/x', writes);

    const table = buildRouteTable(app);
    // The '/x/list' guard applies to the read route only.
    expect(entry(table, 'GET', '/x/list').permissions).toHaveLength(1);
    expect(entry(table, 'POST', '/x/new').permissions).toEqual([]);
  });

  it('composes nested routers and keeps per-route gates separate from siblings', () => {
    const app = express();
    const outer = Router();
    const inner = Router();
    inner.delete('/:id', requireStepUp, audited('plugin.purge'), noop);
    inner.get('/:id', requirePermission('plugins:read'), noop);
    outer.use('/items', requirePermission('plugins:write'), inner);
    app.use('/api', requireAuth, outer);

    const table = buildRouteTable(app);
    const del = entry(table, 'DELETE', '/api/items/:id');
    expect(del.auth).toBe(true);
    expect(del.stepUp).toBe(true);
    expect(del.audit).toEqual(['plugin.purge']);
    expect(del.permissions.map((p) => p.permissions)).toEqual([['plugins:write']]);
    // The sibling GET picks up the mount guard plus its own, and NOT step-up.
    const get = entry(table, 'GET', '/api/items/:id');
    expect(get.stepUp).toBe(false);
    expect(get.permissions.map((p) => p.permissions)).toEqual([['plugins:write'], ['plugins:read']]);
  });

  it('applies a path-less router.use(gate) to every router mounted after it', () => {
    // The shape compliance uses: reads mount first, then one shared write gate,
    // then the write routers. A '/'-mounted layer matches any path (router@2's
    // `slash` fast path), so the gate must reach `DELETE /rules/:id` while the
    // earlier read router stays ungated by it.
    const app = express();
    const rules = Router();
    const reads = Router();
    reads.get('/:id', requirePermission('compliance:read'), noop);
    const writes = Router();
    writes.delete('/:id', audited('compliance.rule.delete'), noop);
    rules.use(reads);
    rules.use(requirePermission('compliance:write'));
    rules.use(writes);
    app.use('/rules', requireAuth, rules);

    const table = buildRouteTable(app);
    expect(entry(table, 'DELETE', '/rules/:id').permissions.map((p) => p.permissions)).toEqual([['compliance:write']]);
    expect(entry(table, 'GET', '/rules/:id').permissions.map((p) => p.permissions)).toEqual([['compliance:read']]);
  });

  it('captures every gate kind, including custom gates tagged by a service', () => {
    const app = express();
    const custom = tagRouteGate((_req: unknown, _res: unknown, next: () => void) => next(), {
      kind: 'scope', scope: 'reporting:ingest',
    });
    app.post('/all', requireAuth, requireAllPermissions('billing:manage', 'org:settings'), audited('billing.addon.add'), noop);
    app.post('/admin', requireAuth, requireSystemAdmin, audited('quota.reset'), noop);
    app.post('/internal', requireAuth, requireServicePrincipal, noop);
    app.post('/internal/notify', requireAuth, requireInternalService({ callers: ['platform', 'billing'] }), noop);
    app.get('/svc', requireAuth, requirePermissionOrService('reports:read'), noop);
    app.post('/ingest', requireAuth, custom, audited('pipeline.create'), noop);
    app.get('/gated', requireAuth, requireFeature('advanced_reporting'), requirePermission('reports:read'), noop);

    const table = buildRouteTable(app);
    expect(entry(table, 'POST', '/all').permissions).toEqual([
      { mode: 'all', permissions: ['billing:manage', 'org:settings'], allowService: false },
    ]);
    expect(entry(table, 'POST', '/admin').systemAdmin).toBe(true);
    expect(entry(table, 'POST', '/internal').servicePrincipal).toBe(true);
    expect(entry(table, 'POST', '/internal').internalCallers).toEqual([]);
    // An internal route records BOTH: it is service-only, and exactly which
    // services may call it (the same list the mesh policy names).
    expect(entry(table, 'POST', '/internal/notify').servicePrincipal).toBe(true);
    expect(entry(table, 'POST', '/internal/notify').internalCallers).toEqual(['billing', 'platform']);
    expect(entry(table, 'GET', '/svc').permissions[0].allowService).toBe(true);
    expect(entry(table, 'POST', '/ingest').scopes).toEqual(['reporting:ingest']);
    expect(entry(table, 'GET', '/gated').features).toEqual(['advanced_reporting']);
  });

  it('keeps only the first registration of a duplicated method + path (what Express serves)', () => {
    const app = express();
    const first = Router();
    first.get('/dup', requirePermission('pipelines:read'), noop);
    const second = Router();
    second.get('/dup', requirePermission('plugins:read'), noop);
    app.use('/', first);
    app.use('/', second);

    const table = buildRouteTable(app).filter((e) => e.path === '/dup');
    expect(table).toHaveLength(1);
    expect(table[0].permissions[0].permissions).toEqual(['pipelines:read']);
  });

  it('summarizes writes, ungated routes and missing audits', () => {
    const app = express();
    app.get('/open', noop);
    app.post('/gated', requireAuth, requirePermission('plugins:write'), audited('plugin.update'), noop);
    app.post('/loose', requireAuth, requirePermission('plugins:write'), noop);

    expect(summarizeRouteTable(buildRouteTable(app))).toEqual({ routes: 3, writes: 2, ungated: 1, unaudited: 1, internal: 0 });
    expect(isWriteMethod('GET')).toBe(false);
    expect(isWriteMethod('PATCH')).toBe(true);
  });
});

describe('findRouteCoverageViolations', () => {
  const app = express();
  app.get('/open', noop);
  app.post('/unaudited', requireAuth, requirePermission('plugins:write'), noop);
  app.post('/ungated', noop);
  app.post('/ok', requireAuth, requirePermission('plugins:write'), audited('plugin.update'), noop);
  app.delete('/no-auth', requirePermission('plugins:write'), audited('plugin.delete'), noop);
  const table = buildRouteTable(app);

  it('reports an ungated read, an unaudited write, and a gate without requireAuth', () => {
    const { violations } = findRouteCoverageViolations(table);
    expect(violations).toEqual([
      'DELETE /no-auth: permission gate without requireAuth — the gate can never see a user',
      'GET /open: no permission gate (add requirePermission/requireSystemAdmin, or an exception with a reason)',
      'POST /unaudited: write route declares no audit action (wrap the handler chain in audited(\'<action>\'))',
      'POST /ungated: no permission gate (add requirePermission/requireSystemAdmin, or an exception with a reason)',
      'POST /ungated: write route declares no audit action (wrap the handler chain in audited(\'<action>\'))',
    ]);
  });

  it('honours exceptions by rule, path and method', () => {
    const exceptions: RouteCoverageException[] = [
      { path: '/open', waive: 'permission', reason: 'public probe' },
      { method: 'POST', path: '/ungated', waive: 'all', reason: 'signed webhook' },
      { path: '/unaudited', waive: 'audit', reason: 'nothing persisted' },
    ];
    const { violations, unusedExceptions } = findRouteCoverageViolations(table, exceptions);
    expect(violations).toEqual([
      'DELETE /no-auth: permission gate without requireAuth — the gate can never see a user',
    ]);
    expect(unusedExceptions).toEqual([]);
  });

  it('flags a stale exception that waives nothing', () => {
    const { unusedExceptions } = findRouteCoverageViolations(table, [
      { path: '/ok', waive: 'audit', reason: 'no longer true' },
      { path: '/gone', waive: 'all', optional: true, reason: 'shared infra exception' },
    ]);
    expect(unusedExceptions).toEqual(['* /ok — no longer true']);
  });
});

describe('internal-route coverage (#14)', () => {
  const buildApp = () => {
    const app = express();
    app.post('/messages/internal/notify', requireAuth, requireInternalService({ callers: ['platform'] }), audited('message.notify'), noop);
    app.post('/quotas/:orgId/increment', requireAuth, requireInternalService({ callers: ['pipeline', 'plugin'] }), audited('quota.increment'), noop);
    return app;
  };

  it('flags an /internal path that is not gated by requireInternalService', () => {
    const app = express();
    app.post('/messages/internal/notify', requireAuth, requireServicePrincipal, audited('message.notify'), noop);
    const { violations } = findRouteCoverageViolations(buildRouteTable(app));
    expect(violations).toContain('POST /messages/internal/notify: an /internal route without requireInternalService({ callers: [...] }) — user tokens would reach it');
  });

  it('accepts an /internal path that IS gated', () => {
    const { violations } = findRouteCoverageViolations(buildRouteTable(buildApp()));
    expect(violations.filter((v) => v.includes('/internal'))).toEqual([]);
  });

  it('checks declarations in both directions', () => {
    const table = buildRouteTable(buildApp());
    expect(findInternalRouteViolations(table, [
      { method: 'POST', path: '/messages/internal/notify', callers: ['platform'] },
      { method: 'POST', path: '/quotas/:orgId/increment', callers: ['plugin', 'pipeline'] },
    ])).toEqual([]);

    // A route the table says is internal but nobody declared.
    expect(findInternalRouteViolations(table, [
      { method: 'POST', path: '/messages/internal/notify', callers: ['platform'] },
    ])).toEqual([
      'POST /quotas/:orgId/increment: gated by requireInternalService but not declared (add it here and to the mesh policy)',
    ]);

    // A declared caller list that no longer matches the code.
    expect(findInternalRouteViolations(table, [
      { method: 'POST', path: '/messages/internal/notify', callers: ['billing'] },
      { method: 'POST', path: '/quotas/:orgId/increment', callers: ['plugin', 'pipeline'] },
    ])).toEqual([
      'POST /messages/internal/notify: internal callers are [platform] but [billing] were declared',
    ]);

    // A declaration for a route that does not exist.
    expect(findInternalRouteViolations(table, [
      { method: 'POST', path: '/messages/internal/notify', callers: ['platform'] },
      { method: 'POST', path: '/quotas/:orgId/increment', callers: ['plugin', 'pipeline'] },
      { method: 'DELETE', path: '/gone/internal', callers: ['platform'] },
    ])).toEqual(['DELETE /gone/internal: declared internal but the route does not exist']);
  });
});
