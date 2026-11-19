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
    expect(r.features).toEqual(['cross_account_runners']);
    expect(r.stepUp).toBe(true);
    expect(r.minAssurance).toBe(2);
    expect(r.audit).toEqual([action]);
  });

  it('GET /pipelines/runners: org_settings:write, no step-up', () => {
    const r = route('GET', '/pipelines/runners');
    expect(perms(r)).toEqual(['org_settings:write']);
    expect(r.features).toEqual(['cross_account_runners']);
    expect(r.stepUp).toBe(false);
  });

  it('GET /pipelines/:pipelineId/run-requests/:requestId: pipelines:read', () => {
    expect(perms(route('GET', '/pipelines/:pipelineId/run-requests/:requestId'))).toEqual(['pipelines:read']);
  });

  it('GET /pipelines/runner/jwks.json is PUBLIC and unmetered', () => {
    const r = route('GET', '/pipelines/runner/jwks.json');
    expect(r.auth).toBe(false);
    expect(r.permissions).toEqual([]);
    expect(r.quota?.metered ?? []).toEqual([]);
  });

  it('no poll-mode route exists', () => {
    expect(table.some((e) => /runner\/(claim|requests)/.test(e.path))).toBe(false);
  });

});
