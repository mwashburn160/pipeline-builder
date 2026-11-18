// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /ready` must follow the service readiness flag, not only the datastore
 * probe. The flag is what graceful shutdown flips first (and what stays false
 * until startup bootstraps finish); if `/ready` ignores it, the orchestrator's
 * readiness probe keeps the instance in rotation while it drains, so new
 * requests keep arriving at a process that is tearing itself down.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.NODE_ENV = 'test';

const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  ...actualApiCore,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.unstable_mockModule('uuid', () => ({ v7: () => '00000000-0000-0000-0000-000000000000' }));

const { createApp } = await import('../src/api/app-factory.js');
const { setReady, withReadinessState } = await import('../src/api/readiness.js');

let server: Server;
let base: string;

const status = (path: string): Promise<number> => new Promise((resolve, reject) => {
  http.get(`${base}${path}`, { agent: false }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode ?? 0));
  }).on('error', reject);
});

beforeAll(async () => {
  // The datastore itself is healthy throughout.
  const { app } = createApp({
    enableRateLimit: false,
    enableOpenApi: false,
    enableHelmet: false,
    checkDependencies: async () => ({ postgres: 'connected' }),
  });
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setReady(true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /ready', () => {
  it('is 200 while ready and 503 once NotReady, even with the datastore connected', async () => {
    setReady(true);
    const ready = await status('/ready');
    setReady(false);
    const notReady = await status('/ready');
    // Liveness is unaffected: a draining process is still alive.
    const health = await status('/health');
    setReady(true);

    expect({ ready, notReady, health }).toEqual({ ready: 200, notReady: 503, health: 200 });
  });
});

describe('withReadinessState', () => {
  it('adds the flag to the wrapped check (and works with no check)', async () => {
    setReady(false);
    await expect(withReadinessState(async () => ({ mongodb: 'connected' }))()).resolves.toEqual({ mongodb: 'connected', readiness: 'disconnected' });
    setReady(true);
    await expect(withReadinessState()()).resolves.toEqual({ readiness: 'connected' });
  });
});
