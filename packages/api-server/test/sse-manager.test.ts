// Mock uuid (ESM-only module) and createLogger (Winston open handles) before imports
jest.mock('uuid', () => ({
  v7: () => 'mock-uuid-v7',
}));
jest.mock('@mwashburn160/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { SSEManager } from '../src/http/sse-connection-manager';

// ---------------------------------------------------------------------------
// Mock Response
// ---------------------------------------------------------------------------
function mockSseRes() {
  const res: any = {
    writtenData: [] as string[],
    ended: false,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { res.headers[name] = value; },
    write(data: string) { res.writtenData.push(data); return true; },
    end() { res.ended = true; },
    flushHeaders() {},
    on(event: string, handler: () => void) {
      if (event === 'close') res._closeHandler = handler;
    },
    _closeHandler: null as (() => void) | null,
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSEManager', () => {
  let manager: SSEManager;

  beforeEach(() => {
    manager = new SSEManager({
      maxClientsPerRequest: 3,
      clientTimeoutMs: 60000,
      cleanupIntervalMs: 0, // Disable automatic cleanup
    });
  });

  afterEach(() => {
    manager.shutdown();
  });

  describe('getStats', () => {
    it('should return empty stats initially', () => {
      const stats = manager.getStats();
      expect(stats.totalRequests).toBe(0);
      expect(stats.totalClients).toBe(0);
      expect(stats.oldestConnectionMs).toBeNull();
    });

    it('should track connected clients', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      const stats = manager.getStats();
      expect(stats.totalRequests).toBe(1);
      expect(stats.totalClients).toBe(1);
      expect(stats.oldestConnectionMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('hasClients', () => {
    it('should return false when no clients connected', () => {
      expect(manager.hasClients('nonexistent')).toBe(false);
    });

    it('should return true when client is connected', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      expect(manager.hasClients('req-1')).toBe(true);
    });
  });

  describe('getClientCount', () => {
    it('should return 0 for no clients', () => {
      expect(manager.getClientCount('nonexistent')).toBe(0);
    });

    it('should count clients per request', () => {
      manager.addClient('req-1', mockSseRes());
      manager.addClient('req-1', mockSseRes());
      expect(manager.getClientCount('req-1')).toBe(2);
    });
  });

  describe('addClient', () => {
    it('should add a client and return true', () => {
      const res = mockSseRes();
      const added = manager.addClient('req-1', res);
      expect(added).toBe(true);
      expect(manager.getClientCount('req-1')).toBe(1);
    });

    it('should reject when max clients reached', () => {
      manager.addClient('req-1', mockSseRes());
      manager.addClient('req-1', mockSseRes());
      manager.addClient('req-1', mockSseRes());
      const added = manager.addClient('req-1', mockSseRes());
      expect(added).toBe(false);
      expect(manager.getClientCount('req-1')).toBe(3);
    });

    it('should handle different request IDs independently', () => {
      manager.addClient('req-1', mockSseRes());
      manager.addClient('req-2', mockSseRes());
      expect(manager.getClientCount('req-1')).toBe(1);
      expect(manager.getClientCount('req-2')).toBe(1);
    });
  });

  describe('send', () => {
    it('should send SSE event to connected clients', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      const count = manager.send('req-1', 'INFO', 'Hello');
      expect(count).toBe(1);
      expect(res.writtenData.length).toBeGreaterThan(0);
      expect(res.writtenData.join('')).toContain('Hello');
    });

    it('should return 0 for unknown request', () => {
      expect(manager.send('unknown', 'INFO', 'test')).toBe(0);
    });
  });

  describe('broadcast', () => {
    it('should send to all connected clients', () => {
      const res1 = mockSseRes();
      const res2 = mockSseRes();
      manager.addClient('req-1', res1);
      manager.addClient('req-2', res2);
      const count = manager.broadcast('INFO', 'Broadcast msg');
      expect(count).toBe(2);
    });

    it('should return 0 with no clients', () => {
      expect(manager.broadcast('INFO', 'test')).toBe(0);
    });
  });

  describe('closeRequest', () => {
    it('should close all clients for a request', () => {
      const res1 = mockSseRes();
      const res2 = mockSseRes();
      manager.addClient('req-1', res1);
      manager.addClient('req-1', res2);
      manager.closeRequest('req-1');
      expect(manager.hasClients('req-1')).toBe(false);
      expect(res1.ended).toBe(true);
      expect(res2.ended).toBe(true);
    });

    it('should handle closing non-existent request', () => {
      expect(() => manager.closeRequest('nonexistent')).not.toThrow();
    });

    it('should send final message before closing', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      manager.closeRequest('req-1', 'Goodbye');
      expect(res.writtenData.join('')).toContain('Goodbye');
      expect(res.ended).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should close all connections', () => {
      const res1 = mockSseRes();
      const res2 = mockSseRes();
      manager.addClient('req-1', res1);
      manager.addClient('req-2', res2);
      manager.shutdown();
      expect(manager.getStats().totalClients).toBe(0);
    });
  });

  describe('removeClient on close', () => {
    it('should remove client when response closes', () => {
      const res = mockSseRes();
      manager.addClient('req-1', res);
      expect(manager.getClientCount('req-1')).toBe(1);
      // Simulate response close
      if (res._closeHandler) res._closeHandler();
      expect(manager.getClientCount('req-1')).toBe(0);
    });
  });
});
