// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The GC schedulers are torn down by runServer's coordinated `onShutdown`, not
 * by `process.once('SIGTERM')` hooks of their own that raced it: boot starts
 * both, shutdown stops both, and nothing in boot registers a SIGTERM listener.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

type ServerOpts = { onBeforeStart?: () => Promise<void>; onShutdown?: () => Promise<void> };
let serverOpts: ServerOpts | undefined;
const order: string[] = [];

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  wireServiceSecurity: () => undefined,
  createQuotaService: () => ({}),
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  createApp: () => ({ app: { use: () => undefined }, sseManager: {} }),
  attachRequestContext: () => () => undefined,
  runServer: (_app: unknown, opts: ServerOpts) => { serverOpts = opts; return Promise.resolve(); },
}));
jest.unstable_mockModule('../src/app-routes.js', () => ({ mountRoutes: () => undefined }));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { port: 3000, registry: { host: 'registry', port: 5000 } } }));
jest.unstable_mockModule('../src/routes/internal.js', () => ({ OWN_BODY_PARSER_PATHS: [] }));
jest.unstable_mockModule('../src/services/gc-scheduler.js', () => ({
  startGcScheduler: () => order.push('start-gc'),
  startQuarantineGcScheduler: () => order.push('start-quarantine'),
  stopGcScheduler: () => order.push('stop-gc'),
  stopQuarantineGcScheduler: () => order.push('stop-quarantine'),
}));

const sigtermBefore = process.listenerCount('SIGTERM');
await import('../src/index.js');

describe('image-registry shutdown wiring', () => {
  it('starts both GC schedulers at boot without registering a SIGTERM hook', async () => {
    await serverOpts!.onBeforeStart!();
    expect(order).toEqual(['start-gc', 'start-quarantine']);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('stops both GC schedulers in runServer onShutdown', async () => {
    order.length = 0;
    expect(serverOpts?.onShutdown).toBeInstanceOf(Function);
    await serverOpts!.onShutdown!();
    expect(order).toEqual(['stop-gc', 'stop-quarantine']);
  });
});
