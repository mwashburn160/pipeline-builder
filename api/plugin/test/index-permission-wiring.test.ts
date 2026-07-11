// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring test for src/index.ts route mounts.
 *
 * Security regression lock-in: the update, delete, and bulk `/plugins` mounts
 * must sit behind `requirePermission('plugins:write')`. The guard is applied at
 * the app-mount layer (index.ts), NOT inside the individual route factories, so
 * this test drives index.ts with every heavy dependency mocked and inspects the
 * middleware stack captured from `app.use(...)`.
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
} as const;

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
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  createApp: () => ({ app, sseManager: {} }),
  runServer: jest.fn(),
  createProtectedRoute: () => [],
  createAuthenticatedWithOrgRoute: () => [],
  attachRequestContext: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  postgresHealthCheck: () => async () => ({ ok: true }),
  redisHealthCheck: () => async () => ({ ok: true }),
  combineHealthChecks: (...fns: unknown[]) => fns,
}));

jest.unstable_mockModule('../src/queue/plugin-build-queue.js', () => ({
  startWorker: jest.fn(),
  waitForWorkerReady: jest.fn(async () => undefined),
  shutdownQueue: jest.fn(async () => undefined),
  getHealthRedisConnection: jest.fn(),
}));

jest.unstable_mockModule('../src/routes/bulk-plugin.js', () => ({ createBulkPluginRoutes: () => ROUTERS.bulk }));
jest.unstable_mockModule('../src/routes/delete-plugin.js', () => ({ createDeletePluginRoutes: () => ROUTERS.delete }));
jest.unstable_mockModule('../src/routes/deploy-generated-plugin.js', () => ({ createDeployGeneratedPluginRoutes: () => ROUTERS.deploy }));
jest.unstable_mockModule('../src/routes/generate-plugin.js', () => ({ createGeneratePluginRoutes: () => ROUTERS.generate }));
jest.unstable_mockModule('../src/routes/queue-status.js', () => ({ createQueueStatusRoutes: () => ROUTERS.queueStatus }));
jest.unstable_mockModule('../src/routes/read-plugins.js', () => ({ createReadPluginRoutes: () => ROUTERS.read }));
jest.unstable_mockModule('../src/routes/update-plugin.js', () => ({ createUpdatePluginRoutes: () => ROUTERS.update }));
jest.unstable_mockModule('../src/routes/upload-plugin.js', () => ({ createUploadPluginRoutes: () => ROUTERS.upload }));

await import('../src/index.js');

/** Find the app.use(...) call that mounts the given router marker. */
function mountFor(marker: unknown): unknown[] {
  const call = useCalls.find((args) => args[args.length - 1] === marker);
  if (!call) throw new Error('No mount found for the given router marker');
  return call;
}

function hasWriteGuard(args: unknown[]): boolean {
  return args.some((a) => typeof a === 'function' && (a as any).__permission === 'plugins:write');
}

describe('src/index.ts — plugins:write enforcement', () => {
  it('mounts the update route behind requirePermission("plugins:write")', () => {
    expect(hasWriteGuard(mountFor(ROUTERS.update))).toBe(true);
  });

  it('mounts the delete route behind requirePermission("plugins:write")', () => {
    expect(hasWriteGuard(mountFor(ROUTERS.delete))).toBe(true);
  });

  it('mounts the bulk route behind requirePermission("plugins:write") + bulk_operations feature', () => {
    const args = mountFor(ROUTERS.bulk);
    expect(hasWriteGuard(args)).toBe(true);
    expect(args.some((a) => typeof a === 'function' && (a as any).__feature === 'bulk_operations')).toBe(true);
  });

  it('does NOT gate the read route with the write permission', () => {
    // Read is a query path — gating it behind plugins:write would be a
    // false positive here and a regression in prod.
    expect(hasWriteGuard(mountFor(ROUTERS.read))).toBe(false);
  });
});
