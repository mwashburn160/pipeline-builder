// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring test for src/index.ts route mounts.
 *
 * Security regression lock-in: the update, delete, bulk, purge and restore
 * `/plugins` routers must sit behind `requirePermission('plugins:write')`. The
 * guard is applied at the app-mount layer (index.ts), NOT inside the individual
 * route factories, so this test drives index.ts with every heavy dependency
 * mocked and inspects the middleware stack captured from `app.use(...)`.
 *
 * Behavioral proof of the mount ORDER (single idempotency pass, single step-up
 * consumption) lives in index-wiring-real.test.ts, which runs the real stack.
 *
 * The read mount is asserted NOT to carry the write guard, so the test fails if
 * someone accidentally moves/removes the guard onto the wrong mount.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// Capture every app.use(...) call so we can inspect the middleware stacks.
const useCalls: unknown[][] = [];
const app = {
  use: (...args: unknown[]) => { useCalls.push(args); return app; },
};

// Distinct marker objects per route factory so a mount is identified by its
// final argument (the router) regardless of the shared '/plugins' path.
const ROUTERS = {
  upload: { __router: 'upload' },
  queueStatus: { __router: 'queueStatus' },
  generate: { __router: 'generate' },
  deploy: { __router: 'deploy' },
  read: { __router: 'read' },
  update: { __router: 'update' },
  delete: { __router: 'delete' },
  bulk: { __router: 'bulk' },
  restore: { __router: 'restore' },
  purge: { __router: 'purge' },
} as const;

/** Stand-ins for the shared middleware so their placement can be asserted. */
const AUTH_CHAIN = { __chain: 'auth+org+idempotency+tenant' };
const API_CALLS_QUOTA = { __quota: 'apiCalls' };
const STEP_UP = { __stepUp: true };

/** requirePermission/requireFeature return tagged guards so we can assert them. */
const permGuard = (perm: string) => {
  const g = (_req: unknown, _res: unknown, next?: () => void) => next?.();
  (g as any).__permission = perm;
  return g;
};
const featureGuard = (feature: string) => {
  const g = (_req: unknown, _res: unknown, next?: () => void) => next?.();
  (g as any).__feature = feature;
  return g;
};

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: () => ({}),
  registerComplianceEventSubscriber: jest.fn(),
  requirePermission: (perm: string) => permGuard(perm),
  requireFeature: (feature: string) => featureGuard(feature),
  requireStepUp: STEP_UP,
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  createApp: () => ({ app, sseManager: {} }),
  runServer: jest.fn(),
  // Pass the handler through — this suite inspects mount/middleware wiring, not
  // handler behavior. Needed since the (real) purge/restore routes use withRoute.
  withRoute: (handler: unknown) => handler,
  checkQuota: (_qs: unknown, type: string) => (type === 'apiCalls' ? API_CALLS_QUOTA : { __quota: type }),
  createAuthenticatedWithOrgRoute: () => [AUTH_CHAIN],
  attachRequestContext: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  postgresHealthCheck: () => async () => ({ ok: true }),
  redisHealthCheck: () => async () => ({ ok: true }),
  combineHealthChecks: (...fns: unknown[]) => fns,
}));

jest.unstable_mockModule('../src/queue/plugin-build-queue.js', () => ({
  startWorker: jest.fn(),
  waitForWorkerReady: jest.fn(async () => undefined),
  shutdownQueue: jest.fn(async () => undefined),
}));
jest.unstable_mockModule('../src/queue/connections.js', () => ({ getHealthRedisConnection: jest.fn() }));

jest.unstable_mockModule('../src/routes/bulk-plugin.js', () => ({ createBulkPluginRoutes: () => ROUTERS.bulk }));
jest.unstable_mockModule('../src/routes/delete-plugin.js', () => ({ createDeletePluginRoutes: () => ROUTERS.delete }));
jest.unstable_mockModule('../src/routes/deploy-generated-plugin.js', () => ({ createDeployGeneratedPluginRoutes: () => ROUTERS.deploy }));
jest.unstable_mockModule('../src/routes/generate-plugin.js', () => ({ createGeneratePluginRoutes: () => ROUTERS.generate }));
jest.unstable_mockModule('../src/routes/queue-status.js', () => ({ createQueueStatusRoutes: () => ROUTERS.queueStatus }));
jest.unstable_mockModule('../src/routes/read-plugins.js', () => ({ createReadPluginRoutes: () => ROUTERS.read }));
jest.unstable_mockModule('../src/routes/update-plugin.js', () => ({ createUpdatePluginRoutes: () => ROUTERS.update }));
jest.unstable_mockModule('../src/routes/upload-plugin.js', () => ({ createUploadPluginRoutes: () => ROUTERS.upload }));
jest.unstable_mockModule('../src/routes/restore-plugin.js', () => ({ createRestorePluginRoutes: () => ROUTERS.restore }));
jest.unstable_mockModule('../src/routes/purge-plugin.js', () => ({ createPurgePluginRoutes: () => ROUTERS.purge }));
// Purge-scheduler deps the index now imports — mock so the real pipeline-data
// barrel / pluginService aren't pulled into this wiring test.
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({ pluginService: {} }));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({ createSoftDeletePurgeScheduler: () => null }));

await import('../src/index.js');

/** Find the app.use(...) call that mounts the given router marker. */
function mountFor(marker: unknown): unknown[] {
  const call = useCalls.find((args) => args.includes(marker));
  if (!call) throw new Error('No mount found for the given router marker');
  return call;
}

/** The layers that run BEFORE `marker` within its mount (the gates it inherits). */
function gatesBefore(marker: unknown): unknown[] {
  const args = mountFor(marker);
  return args.slice(1, args.indexOf(marker));
}

function hasWriteGuard(layers: unknown[]): boolean {
  return layers.some((a) => typeof a === 'function' && (a as any).__permission === 'plugins:write');
}

describe('src/index.ts — plugins:write enforcement', () => {
  it.each(['update', 'delete', 'bulk', 'purge', 'restore'] as const)('mounts the %s route behind requirePermission("plugins:write")', (name) => {
    expect(hasWriteGuard(gatesBefore(ROUTERS[name]))).toBe(true);
  });

  it('purge and restore sit behind ONE shared requireStepUp layer (single jti consumption)', () => {
    const args = mountFor(ROUTERS.purge);
    expect(args).toBe(mountFor(ROUTERS.restore));
    expect(args.filter((a) => a === STEP_UP)).toHaveLength(1);
    expect(args.indexOf(STEP_UP)).toBeLessThan(args.indexOf(ROUTERS.purge));
    expect(args.indexOf(STEP_UP)).toBeLessThan(args.indexOf(ROUTERS.restore));
    expect(useCalls.filter((c) => c.includes(STEP_UP))).toHaveLength(1);
  });

  it('bulk (and update/delete) come BEFORE the step-up layer, so they need no step-up token', () => {
    for (const name of ['bulk', 'update', 'delete'] as const) {
      expect(gatesBefore(ROUTERS[name])).not.toContain(STEP_UP);
    }
  });

  it('does not put the bulk_operations feature gate on the shared write mount (it would leak onto purge/restore)', () => {
    expect(gatesBefore(ROUTERS.restore).some((a) => typeof a === 'function' && (a as any).__feature)).toBe(false);
  });

  it('does NOT gate the read route with the write permission', () => {
    // Read is a query path — gating it behind plugins:write would be a
    // false positive here and a regression in prod.
    expect(hasWriteGuard(gatesBefore(ROUTERS.read))).toBe(false);
    expect(gatesBefore(ROUTERS.read)).toContain(API_CALLS_QUOTA);
  });

  it('does NOT put the ai_generation feature guard on the shared /plugins generate mount', () => {
    // Mount-guard leak fix: `requireFeature('ai_generation')` lives on each
    // generate route inside the router, so it can't 403 a sibling
    // `GET /plugins` read. Re-adding it to the mount would reintroduce the leak.
    expect(gatesBefore(ROUTERS.generate).some((a) => typeof a === 'function' && (a as any).__feature === 'ai_generation')).toBe(false);
  });

  it('applies the auth+org+idempotency+tenant chain exactly ONCE, before every non-upload router', () => {
    const chainMounts = useCalls.filter((c) => c.includes(AUTH_CHAIN));
    expect(chainMounts).toHaveLength(1);
    const chainAt = useCalls.indexOf(chainMounts[0]);
    // Upload hand-wires its own chain (multer ordering) and is mounted first.
    expect(useCalls.indexOf(mountFor(ROUTERS.upload))).toBeLessThan(chainAt);
    for (const name of ['queueStatus', 'generate', 'deploy', 'read', 'update', 'delete', 'bulk', 'purge', 'restore'] as const) {
      expect(useCalls.indexOf(mountFor(ROUTERS[name]))).toBeGreaterThan(chainAt);
    }
  });
});
