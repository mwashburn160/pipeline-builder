// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Small runtime helpers with no suite of their own:
 *  - api/mongo-connect.ts — strict queries, pool sizing from the environment,
 *    and connection listeners wired ONCE however often the supervisor retries;
 *  - api/tracing.ts — `withSpan` returns the callback's value, re-throws its
 *    error unchanged (tracing never alters behaviour), and `shutdownTracing`
 *    is a no-op when the preload owns the SDK.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { connectMongo } = await import('../src/api/mongo-connect.js');
const { withSpan, shutdownTracing } = await import('../src/api/tracing.js');

function fakeMongoose() {
  const listeners: Record<string, Array<(err?: Error) => void>> = {};
  return {
    listeners,
    set: jest.fn(),
    connect: jest.fn(async (..._args: unknown[]) => undefined),
    connection: { on: (event: string, fn: (err?: Error) => void) => { (listeners[event] ??= []).push(fn); } },
  };
}

describe('connectMongo', () => {
  const env = { ...process.env };
  beforeEach(() => { process.env = { ...env }; });

  it('enables strictQuery, sizes the pool from the environment, and wires listeners exactly once', async () => {
    process.env.MONGO_MAX_POOL = '7';
    process.env.MONGO_MIN_POOL = '1';
    process.env.MONGO_SERVER_SELECTION_MS = '900';
    const m = fakeMongoose();
    await connectMongo(m, 'mongodb://db/x');
    await connectMongo(m, 'mongodb://db/x');
    expect(m.set).toHaveBeenCalledWith('strictQuery', true);
    expect(m.connect).toHaveBeenLastCalledWith('mongodb://db/x', { maxPoolSize: 7, minPoolSize: 1, serverSelectionTimeoutMS: 900 });
    expect(Object.keys(m.listeners).sort()).toEqual(['disconnected', 'error', 'reconnected']);
    expect(m.listeners.error).toHaveLength(1);
    // The listeners only log — none may throw.
    m.listeners.error![0]!(new Error('boom'));
    m.listeners.error![0]!();
    m.listeners.disconnected![0]!();
    m.listeners.reconnected![0]!();
  });

  it('defaults the pool when the environment says nothing, and propagates a failed connect', async () => {
    delete process.env.MONGO_MAX_POOL;
    delete process.env.MONGO_MIN_POOL;
    delete process.env.MONGO_SERVER_SELECTION_MS;
    const m = fakeMongoose();
    m.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(connectMongo(m, 'mongodb://down')).rejects.toThrow('ECONNREFUSED');
    await connectMongo(m, 'mongodb://up');
    expect(m.connect).toHaveBeenLastCalledWith('mongodb://up', { maxPoolSize: 20, minPoolSize: 2, serverSelectionTimeoutMS: 5000 });
  });
});

describe('withSpan', () => {
  it('returns the callback result (with and without attributes)', async () => {
    await expect(withSpan('ok', async () => 42, { 'pb.org': 'o1' })).resolves.toBe(42);
    await expect(withSpan('ok', async (span) => { expect(span).toBeDefined(); return 'x'; })).resolves.toBe('x');
  });

  it('re-throws the callback error unchanged — Error or not', async () => {
    const err = new Error('generation failed');
    await expect(withSpan('fail', async () => { throw err; })).rejects.toBe(err);
    await expect(withSpan('fail', async () => { throw 'a string'; })).rejects.toBe('a string');
  });

  it('shutdownTracing is a no-op when no local SDK was started', async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});
