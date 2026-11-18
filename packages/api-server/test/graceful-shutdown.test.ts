// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `installGracefulShutdown` — the ONE shutdown routine every service uses
 * (api-server's `startServer` and platform's own entrypoint):
 * - re-entry guard: a second signal while draining does nothing;
 * - readiness flips NotReady FIRST, before server.close;
 * - beforeClose hooks run before server.close, onStop hooks after it;
 * - OpenTelemetry is flushed after the hooks and before exit(0);
 * - a hook that throws is logged and the rest still run;
 * - an unref'd force-exit timer fires exit(1) when teardown hangs.
 */

import http from 'node:http';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const events: string[] = [];
jest.unstable_mockModule('../src/api/tracing.js', () => ({
  shutdownTracing: async () => { events.push('tracing'); },
}));

const { installGracefulShutdown } = await import('../src/api/graceful-shutdown.js');
const { isReady, setReady } = await import('../src/api/readiness.js');

let exit: jest.SpiedFunction<typeof process.exit>;
let server: http.Server;
let uninstall: (() => void) | undefined;

/** A real listener whose close() records the readiness state it saw. */
async function listeningServer(): Promise<http.Server> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const realClose = s.close.bind(s);
  s.close = ((cb?: (err?: Error) => void) => {
    events.push(`close(ready=${isReady()})`);
    return realClose(cb);
  }) as typeof s.close;
  return s;
}

async function waitFor(pred: () => boolean, ms = 1_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(async () => {
  events.length = 0;
  setReady(true);
  exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { events.push(`exit(${code ?? 0})`); }) as never);
  server = await listeningServer();
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  exit.mockRestore();
  if (server.listening) server.close();
});

describe('installGracefulShutdown', () => {
  it('orders: NotReady -> beforeClose -> server.close -> onStop -> tracing -> exit(0)', async () => {
    const handle = installGracefulShutdown({
      server,
      name: 'svc',
      signals: [],
      beforeClose: [() => { events.push(`beforeClose(ready=${isReady()})`); }],
      onStop: [
        async () => { events.push('stop1'); },
        () => { events.push('stop2'); },
      ],
    });
    uninstall = handle.uninstall;

    await handle.shutdown('SIGTERM');
    await waitFor(() => events.includes('exit(0)'));

    expect(events).toEqual([
      'beforeClose(ready=false)',
      'close(ready=false)',
      'stop1',
      'stop2',
      'tracing',
      'exit(0)',
    ]);
  });

  it('runs once when two signals arrive', async () => {
    const handle = installGracefulShutdown({
      server,
      signals: ['SIGTERM', 'SIGINT'],
      onStop: [() => { events.push('stop'); }],
    });
    uninstall = handle.uninstall;

    process.emit('SIGTERM');
    process.emit('SIGINT');
    process.emit('SIGTERM');
    await waitFor(() => events.includes('exit(0)'));
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toEqual(['close(ready=false)', 'stop', 'tracing', 'exit(0)']);
  });

  it('keeps going when a hook throws', async () => {
    const handle = installGracefulShutdown({
      server,
      signals: [],
      beforeClose: [() => { throw new Error('before boom'); }],
      onStop: [async () => { throw new Error('stop boom'); }, () => { events.push('stop2'); }],
    });
    uninstall = handle.uninstall;

    await handle.shutdown();
    await waitFor(() => events.includes('exit(0)'));

    expect(events).toEqual(['close(ready=false)', 'stop2', 'tracing', 'exit(0)']);
  });

  it('force-exits with 1 when a hook hangs, with the timer armed before any hook runs', async () => {
    const unref = jest.spyOn(global, 'setTimeout');
    const handle = installGracefulShutdown({
      server,
      signals: [],
      timeoutMs: 50,
      beforeClose: [() => new Promise<void>(() => { /* never settles */ })],
    });
    uninstall = handle.uninstall;

    void handle.shutdown();
    await waitFor(() => events.includes('exit(1)'));

    expect(events).toEqual(['exit(1)']);
    expect(isReady()).toBe(false);
    // The force timer never itself keeps the process alive.
    const timer = unref.mock.results.find((r) => (r.value as NodeJS.Timeout | undefined)?.hasRef !== undefined)?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    unref.mockRestore();
  });

  it('uninstall removes the signal listeners it added', () => {
    const before = process.listenerCount('SIGTERM');
    const handle = installGracefulShutdown({ server, signals: ['SIGTERM'] });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    handle.uninstall();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
