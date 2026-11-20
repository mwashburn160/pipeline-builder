// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner routes' gates and audit declarations, read off the REAL route
 * table (the same mount code production serves).
 */

import { beforeAll, describe, expect, it } from '@jest/globals';
import { buildRouteTable, type RouteTableEntry } from '@pipeline-builder/api-core';

process.env.JWT_SECRET ||= 'runner-route-gates-test-secret';

let table: RouteTableEntry[];
beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../../src/app-routes.js'),
  ]);
  const { app } = createApp({ enableOpenApi: false });
  mountRoutes(app, { quotaService: createQuotaService() });
  table = buildRouteTable(app);
});

const route = (method: string, path: string) => {
  const r = table.find((e) => e.method === method && e.path === path);
  if (!r) throw new Error(`${method} ${path} not mounted`);
  return r;
};
const perms = (r: RouteTableEntry) => r.permissions.flatMap((p) => p.permissions);

describe('runner route gates', () => {
  it.each([
    ['POST', '/pipelines/runners', 'pipeline.runner.register'],
    ['PATCH', '/pipelines/runners/:id', 'pipeline.runner.update'],
    ['POST', '/pipelines/runners/:id/test', 'pipeline.runner.test'],
    ['DELETE', '/pipelines/runners/:id', 'pipeline.runner.revoke'],
  ])('%s %s: org_settings:write + step-up + MFA-grade, audited %s', (method, path, action) => {
    const r = route(method, path);
    expect(r.auth).toBe(true);
    expect(perms(r)).toEqual(['org_settings:write']);
    expect(r.features).toEqual([]);
    expect(r.stepUp).toBe(true);
    expect(r.minAssurance).toBe(2);
    expect(r.audit).toEqual([action]);
  });

  it('GET /pipelines/runners: org_settings:write, no step-up', () => {
    const r = route('GET', '/pipelines/runners');
    expect(perms(r)).toEqual(['org_settings:write']);
    expect(r.features).toEqual([]);
    expect(r.stepUp).toBe(false);
  });

  it('GET /pipelines/:pipelineId/run-requests/:requestId: pipelines:read', () => {
    expect(perms(route('GET', '/pipelines/:pipelineId/run-requests/:requestId'))).toEqual(['pipelines:read']);
  });

  it('GET /pipelines/runner/runners/:runnerId/jwks.json is PUBLIC and unmetered; the shared JWKS route is gone', () => {
    const r = route('GET', '/pipelines/runner/runners/:runnerId/jwks.json');
    expect(r.auth).toBe(false);
    expect(r.permissions).toEqual([]);
    expect(r.quota?.metered ?? []).toEqual([]);
    expect(table.some((e) => e.path === '/pipelines/runner/jwks.json')).toBe(false);
  });

  it.each([
    ['POST', '/pipelines/runners/signing-key', 'pipeline.runner.key.generate'],
    ['POST', '/pipelines/runners/signing-key/rotate', 'pipeline.runner.key.rotate'],
    ['DELETE', '/pipelines/runners/signing-key/rotate', 'pipeline.runner.key.cancel'],
    ['POST', '/pipelines/runners/signing-key/finish', 'pipeline.runner.key.finish'],
    ['POST', '/pipelines/runners/signing-key/revoke', 'pipeline.runner.key.revoke'],
    ['PUT', '/pipelines/runners/signing-key/mode', 'pipeline.runner.key.mode'],
  ])('%s %s: org_settings:write + MFA-grade + step-up, no feature, audited %s', (method, path, action) => {
    const r = route(method, path);
    expect(r.auth).toBe(true);
    expect(perms(r)).toEqual(['org_settings:write']);
    expect(r.features).toEqual([]);
    expect(r.stepUp).toBe(true);
    expect(r.minAssurance).toBe(2);
    expect(r.audit).toEqual([action]);
  });

  it.each([
    ['GET', '/pipelines/admin/runner-signing-keys', 'orgs:read', false, []],
    ['GET', '/pipelines/admin/runner-deliveries', 'orgs:read', false, []],
    ['POST', '/pipelines/admin/orgs/:orgId/runner-signing-key/revoke', 'orgs:manage', true, ['pipeline.runner.key.system_revoke']],
    ['PUT', '/pipelines/admin/runner-deliveries', 'orgs:manage', true, ['pipeline.runner.deliveries.pause', 'pipeline.runner.deliveries.resume']],
  ])('%s %s: system org + %s + MFA-grade (step-up %s)', (method, path, perm, stepUp, audit) => {
    const r = route(method, path);
    expect(r.systemOrg).toBe(true);
    expect(perms(r)).toEqual([perm]);
    expect(r.minAssurance).toBe(2);
    expect(r.stepUp).toBe(stepUp);
    expect(r.audit).toEqual(audit);
  });

  it('POST /pipelines/internal/runner-signing-keys/reencrypt: platform only', () => {
    const r = route('POST', '/pipelines/internal/runner-signing-keys/reencrypt');
    expect(r.internalCallers).toEqual(['platform']);
    expect(r.audit).toEqual(['pipeline.runner.key.reencrypt']);
  });

  it('no poll-mode route exists', () => {
    expect(table.some((e) => /runner\/(claim|requests)/.test(e.path))).toBe(false);
  });

});
