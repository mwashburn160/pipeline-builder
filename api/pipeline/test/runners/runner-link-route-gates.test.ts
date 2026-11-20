// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The runner-link routes' gates, read off the REAL route table (the mount production serves). */

import { beforeAll, describe, expect, it } from '@jest/globals';
import { buildRouteTable, type RouteTableEntry } from '@pipeline-builder/api-core';

process.env.JWT_SECRET ||= 'runner-link-route-gates-test-secret';

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

describe('runner-link route gates', () => {
  it('GET /pipelines/:pipelineId/runner-link: pipelines:read, no step-up, no feature', () => {
    const r = route('GET', '/pipelines/:pipelineId/runner-link');
    expect(r.auth).toBe(true);
    expect(perms(r)).toEqual(['pipelines:read']);
    expect(r.stepUp).toBe(false);
    expect(r.features).toEqual([]);
  });

  it('POST /pipelines/:pipelineId/runner-link/refresh: pipelines:write + MFA-grade session + step-up, audited', () => {
    const r = route('POST', '/pipelines/:pipelineId/runner-link/refresh');
    expect(r.auth).toBe(true);
    expect(perms(r)).toEqual(['pipelines:write']);
    expect(r.stepUp).toBe(true);
    expect(r.minAssurance).toBe(2);
    expect(r.audit).toEqual(['pipeline.runner.link.refresh']);
    expect(r.features).toEqual([]);
  });

  it('GET /pipelines/runners/:id/pipelines: org_settings:write, no step-up', () => {
    const r = route('GET', '/pipelines/runners/:id/pipelines');
    expect(perms(r)).toEqual(['org_settings:write']);
    expect(r.stepUp).toBe(false);
  });

  it('Run and Stop stay pipelines:write without any runner feature gate', () => {
    for (const path of ['/pipelines/:pipelineId/executions', '/pipelines/:pipelineId/executions/:executionId/stop']) {
      const r = route('POST', path);
      expect(perms(r)).toEqual(['pipelines:write']);
      expect(r.features).toEqual([]);
    }
  });
});
