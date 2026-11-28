// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route wiring for `POST /observability/client-vitals`: signed-in callers only,
 * then a per-USER and a per-IP bucket, then the handler — in that order, so the
 * per-user bucket keys on the verified caller. Mounted ahead of the
 * `/observability` tenant prefix in app-routes.ts, so browser telemetry never
 * spends (or is refused by) the org's apiCalls quota.
 */

import { jest, describe, it, expect } from '@jest/globals';

const tag = (name: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { __mw: name });

jest.unstable_mockModule('../src/middleware/index.js', () => ({ requireAuth: tag('requireAuth'), tenantScope: tag('tenantScope') }));
jest.unstable_mockModule('../src/middleware/limiters.js', () => ({
  clientVitalsUserLimiter: tag('clientVitalsUserLimiter'),
  clientVitalsIpLimiter: tag('clientVitalsIpLimiter'),
}));
jest.unstable_mockModule('../src/observability/client-vitals.js', () => ({ clientVitals: tag('clientVitals') }));

const { default: router, CLIENT_VITALS_PATH } = await import('../src/routes/client-vitals.js');

describe('client-vitals route', () => {
  it('is served at /observability/client-vitals', () => {
    expect(CLIENT_VITALS_PATH).toBe('/observability/client-vitals');
  });

  it('runs requireAuth, the per-user bucket, the per-IP bucket, then the handler', () => {
    const layer = (router.stack as any[]).find((l) => l.route?.path === '/' && l.route?.methods?.post);
    expect(layer).toBeDefined();
    expect((layer.route.stack as any[]).map((s) => s.handle.__mw)).toEqual([
      'requireAuth', 'clientVitalsUserLimiter', 'clientVitalsIpLimiter', 'clientVitals',
    ]);
  });

  it('serves nothing else', () => {
    expect((router.stack as any[]).filter((l) => l.route).length).toBe(1);
  });
});
