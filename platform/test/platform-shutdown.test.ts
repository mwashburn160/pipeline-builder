// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform's graceful shutdown, driven through the REAL entrypoint's signal
 * handlers. The contract (shared with every api-server service):
 * - a second SIGTERM/SIGINT while draining is a no-op (no second server.close,
 *   no second teardown, no second exit);
 * - readiness flips to NotReady BEFORE server.close, so the load balancer stops
 *   routing new work to a process that is going away;
 * - the platform stop steps (metrics scraper, background sweeps, Mongo) run
 *   before exit, and OpenTelemetry is flushed before exit so the final spans
 *   are exported.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import mongoose from 'mongoose';
import { bootPlatform, waitFor, type PlatformBoot } from './helpers/platform-boot.js';

let boot: PlatformBoot;

beforeAll(async () => { boot = await bootPlatform(); });
// platform's jest config restores spies after every test.
beforeEach(() => boot.arm());
afterAll(() => boot?.cleanup());

describe('platform /ready', () => {
  it('follows the readiness flag, not just Mongo — so a draining (or still-bootstrapping) instance leaves the load balancer', async () => {
    // Mongo itself reports connected throughout (`readyState` is a
    // non-configurable accessor over mongoose's `_readyState`).
    const conn = mongoose.connection as unknown as { _readyState: number };
    const savedState = conn._readyState;
    conn._readyState = 1;
    const base = `http://127.0.0.1:${(boot.server().address() as AddressInfo).port}`;

    // Body drained + `Connection: close`, so no socket outlives the request and
    // the shutdown test's server.close() completes promptly.
    const status = (): Promise<number> => new Promise((resolve, reject) => {
      http.get(`${base}/ready`, { agent: false, headers: { connection: 'close' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }).on('error', reject);
    });

    boot.setReady(true);
    const ready = await status();
    boot.setReady(false);
    const notReady = await status();

    conn._readyState = savedState;

    expect({ ready, notReady }).toEqual({ ready: 200, notReady: 503 });
  });
});

describe('platform graceful shutdown', () => {
  it('runs once for two signals: NotReady before close, stop hooks + tracing flush before exit', async () => {
    // Dependencies "connected": the instance is serving.
    boot.setReady(true);

    process.emit('SIGTERM');
    process.emit('SIGINT');
    await waitFor(() => boot.events.includes('exit(0)'));
    // Give a (buggy) second run time to show itself.
    await new Promise((r) => setTimeout(r, 100));

    expect({ ready: boot.isReady(), events: boot.events }).toEqual({
      ready: false,
      events: [
        'server.close(ready=false)',
        'scraper.stop',
        'mongo.close',
        'tracing.shutdown',
        'exit(0)',
      ],
    });
  });
});
