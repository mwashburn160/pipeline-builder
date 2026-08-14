// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, afterEach } from '@jest/globals';

// Mock uuid (ESM-only) + createLogger (Winston open handles) before imports.
jest.unstable_mockModule('uuid', () => ({ v7: () => 'mock-uuid-v7' }));
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  ...actualApiCore,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { SSEManager } = await import('../src/http/sse-connection-manager.js');
const relayMod = await import('../src/http/sse-relay.js');
type SSERelay = import('../src/http/sse-relay.js').SSERelay;
type SSERelayMessage = import('../src/http/sse-relay.js').SSERelayMessage;

/**
 * An in-process stand-in for the Redis pub/sub bus. Every SSERelay built over it
 * shares one handler list, so publishing from one delivers to every subscriber —
 * exactly what two pods sharing one Redis would see. The JSON round-trip mimics
 * the serialize/parse a real Redis relay performs (so payloads are copies).
 */
function makeBus() {
  const handlers: Array<(m: SSERelayMessage) => void> = [];
  return {
    publish(msg: SSERelayMessage) {
      const frame = JSON.parse(JSON.stringify(msg)) as SSERelayMessage;
      for (const h of [...handlers]) h(frame);
    },
    subscribe(h: (m: SSERelayMessage) => void) { handlers.push(h); },
  };
}

/** An SSERelay adapter over the shared fake bus (one per manager instance). */
function relayFor(bus: ReturnType<typeof makeBus>): SSERelay {
  return {
    publish: (msg) => bus.publish(msg),
    subscribe: (handler) => bus.subscribe(handler),
    close: async () => {},
  };
}

function mockSseRes() {
  const res: any = {
    writtenData: [] as string[],
    ended: false,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { res.headers[name] = value; },
    write(data: string) { res.writtenData.push(data); return true; },
    end() { res.ended = true; },
    flushHeaders() {},
    on(event: string, handler: () => void) { if (event === 'close') res._closeHandler = handler; },
    _closeHandler: null as (() => void) | null,
  };
  return res;
}

const REQ = 'req-cross-pod';

describe('SSEManager cross-pod relay (A3)', () => {
  const managers: Array<InstanceType<typeof SSEManager>> = [];
  const make = (bus: ReturnType<typeof makeBus>) => {
    const m = new SSEManager({ relay: relayFor(bus), cleanupIntervalMs: 0 });
    managers.push(m);
    return m;
  };

  afterEach(() => {
    while (managers.length) managers.pop()!.shutdown();
  });

  it('delivers a send() on pod A to a client connected on pod B', () => {
    const bus = makeBus();
    const podA = make(bus);
    const podB = make(bus);

    const clientB = mockSseRes();
    podB.addClient(REQ, clientB);

    // Producer (pod A) has NO local client for REQ — pre-relay this frame is lost.
    const localDelivered = podA.send(REQ, 'INFO', 'build started');
    expect(localDelivered).toBe(0);

    // ...but pod B's client received it via the relay.
    const received = clientB.writtenData.join('');
    expect(received).toContain('build started');
    expect(received).toContain('"type":"INFO"');
  });

  it('does not double-deliver to the producer pod\'s own local clients', () => {
    const bus = makeBus();
    const podA = make(bus);
    make(bus); // pod B present but no clients

    const clientA = mockSseRes();
    podA.addClient(REQ, clientA);

    podA.send(REQ, 'INFO', 'once');
    // Exactly one frame — local write only; the echoed relay frame (origin === self) is ignored.
    expect(clientA.writtenData.length).toBe(1);
    expect(clientA.writtenData[0]).toContain('once');
  });

  it('relays broadcast() to clients on other pods', () => {
    const bus = makeBus();
    const podA = make(bus);
    const podB = make(bus);

    const clientB = mockSseRes();
    podB.addClient('some-other-subject', clientB);

    podA.broadcast('WARN', 'maintenance soon');
    expect(clientB.writtenData.join('')).toContain('maintenance soon');
  });

  it('falls back to local-only delivery when no relay is wired (Redis unset)', () => {
    const solo = new SSEManager({ cleanupIntervalMs: 0 });
    managers.push(solo);
    const client = mockSseRes();
    solo.addClient(REQ, client);
    const n = solo.send(REQ, 'INFO', 'local');
    expect(n).toBe(1);
    expect(client.writtenData.join('')).toContain('local');
  });

  it('createEnvRedisSSERelay returns null when Redis is not configured', () => {
    const prevUrl = process.env.REDIS_URL;
    const prevHost = process.env.REDIS_HOST;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    try {
      expect(relayMod.createEnvRedisSSERelay()).toBeNull();
    } finally {
      if (prevUrl !== undefined) process.env.REDIS_URL = prevUrl;
      if (prevHost !== undefined) process.env.REDIS_HOST = prevHost;
    }
  });
});
