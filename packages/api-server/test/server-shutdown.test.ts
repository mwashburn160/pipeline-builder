// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Graceful shutdown order: the instance must report NotReady BEFORE any
 * shutdown work runs (so it drains), and the force-exit timer must be armed
 * before awaiting `onShutdown` (so a hung callback can't make the pod ignore
 * SIGTERM until SIGKILL).
 */

import express from 'express';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  installCrashHandlers: jest.fn(),
  resolveRedisConnection: () => null,
  retryForever: async (fn: () => Promise<void>) => fn(),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ port: 0, platformUrl: 'http://platform' }), getAny: () => ({ serviceName: 'test' }), validateAuth: () => undefined },
  // Numeric tunables read at module load by transitively imported modules.
  CoreConstants: new Proxy({}, { get: () => 60_000 }),
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  getConnection: () => ({ testConnection: async () => true }),
  closeConnection: async () => undefined,
}));
jest.unstable_mockModule('../src/api/tracing.js', () => ({ shutdownTracing: async () => undefined }));

const { startServer } = await import('../src/api/server.js');
const { isReady } = await import('../src/api/readiness.js');

const savedEnv = { ...process.env };
beforeAll(() => {
  process.env.SERVICE_SIGNING_KEY_FILE = '/dev/null';
  process.env.SERVICE_KEY_BUNDLE_FILE = '/dev/null';
});
afterAll(() => { process.env = savedEnv; });

describe('startServer shutdown', () => {
  it('goes NotReady first and force-exits even when onShutdown hangs', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let readyDuringShutdown: boolean | undefined;
    const result = await startServer(express(), {
      port: 0,
      testDatabase: false,
      closeDatabase: false,
      shutdownTimeoutMs: 50,
      onShutdown: () => {
        readyDuringShutdown = isReady();
        return new Promise<void>(() => { /* never settles */ });
      },
    });
    // Let the supervisor flip the instance ready.
    await new Promise((r) => setTimeout(r, 20));
    expect(isReady()).toBe(true);

    void result.shutdown();
    await new Promise((r) => setTimeout(r, 120));

    expect(readyDuringShutdown).toBe(false);
    expect(isReady()).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockRestore();
    result.server.close();
  });
});
