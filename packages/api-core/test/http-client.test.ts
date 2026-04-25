// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for HTTP client retry logic: parseRetryAfter, addJitter, and requestWithRetry.
 */

// Mock logger to avoid Winston open handles
jest.mock('../src/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Mock the http module so no real network calls are made
jest.mock('http');

import * as http from 'http';
import { InternalHttpClient } from '../src/services/http-client';
import { parseRetryAfter, addJitter } from '../src/services/retry-strategy';

// parseRetryAfter
describe('parseRetryAfter', () => {
  it('returns ms from numeric seconds header', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });

  it('returns ms from "0" header', () => {
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('returns undefined for missing header', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseRetryAfter('')).toBeUndefined();
  });

  it('returns undefined for invalid string', () => {
    expect(parseRetryAfter('not-a-number')).toBeUndefined();
  });

  it('caps at 60s maximum', () => {
    expect(parseRetryAfter('120')).toBe(60_000);
  });

  it('handles string array (picks first)', () => {
    expect(parseRetryAfter(['3', '10'])).toBe(3000);
  });

  it('parses HTTP-date format', () => {
    const futureDate = new Date(Date.now() + 5000).toUTCString();
    const result = parseRetryAfter(futureDate);
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThan(0);
    expect(result!).toBeLessThanOrEqual(60_000);
  });

  it('returns undefined for past HTTP-date', () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString();
    expect(parseRetryAfter(pastDate)).toBeUndefined();
  });
});

// addJitter
describe('addJitter', () => {
  it('returns value within ±25% of input', () => {
    const base = 1000;
    for (let i = 0; i < 100; i++) {
      const result = addJitter(base);
      expect(result).toBeGreaterThanOrEqual(750);
      expect(result).toBeLessThanOrEqual(1250);
    }
  });

  it('never returns negative for small values', () => {
    for (let i = 0; i < 100; i++) {
      expect(addJitter(1)).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns 0 for 0 input', () => {
    expect(addJitter(0)).toBe(0);
  });
});

// InternalHttpClient retry behavior
describe('InternalHttpClient retry behavior', () => {
  let mockRequest: jest.Mock;
  let client: InternalHttpClient;

  /**
   * Helper to set up what http.request returns for each call.
   * Each entry in `responses` is either an object { statusCode, body, headers } or an Error.
   */
  function setupMockResponses(responses: Array<{ statusCode: number; headers?: Record<string, string>; body?: string } | Error>) {
    let callIndex = 0;

    mockRequest.mockImplementation((_opts: unknown, callback: (res: any) => void): any => {
      const entry = responses[callIndex++] ?? responses[responses.length - 1];
      const req: any = {
        on: jest.fn((event: string, handler: (...args: unknown[]) => void): any => {
          if (event === 'error' && entry instanceof Error) {
            setImmediate(() => handler(entry));
          }
          return req;
        }),
        write: jest.fn(),
        end: jest.fn(() => {
          if (!(entry instanceof Error)) {
            const res: any = {
              statusCode: entry.statusCode,
              headers: entry.headers ?? {},
              on: jest.fn((event: string, handler: (...args: unknown[]) => void): any => {
                if (event === 'data' && entry.body) {
                  handler(entry.body);
                }
                if (event === 'end') {
                  setImmediate(() => handler());
                }
                return res;
              }),
            };
            callback(res);
          }
        }),
        destroy: jest.fn(),
      };
      return req;
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockRequest = http.request as jest.Mock;
    mockRequest.mockReset();
    client = new InternalHttpClient({ host: 'localhost', port: 3000 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Run a client call advancing fake timers to flush retries.
   */
  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    // Advance timers repeatedly until the promise resolves
    let resolved = false;
    let result: T;
    let error: unknown;

    promise.then(
      (r) => { resolved = true; result = r; },
      (e) => { resolved = true; error = e; },
    );

    // Flush up to 20 rounds of timers
    for (let i = 0; i < 20 && !resolved; i++) {
      await Promise.resolve(); // let microtasks run
      jest.advanceTimersByTime(100_000); // large advance to cover any backoff
      await Promise.resolve();
    }

    if (error) throw error;
    return result!;
  }

  describe('429 handling', () => {
    it('retries on 429 and succeeds after rate limit clears', async () => {
      setupMockResponses([
        { statusCode: 429, headers: { 'retry-after': '1' }, body: '{}' },
        { statusCode: 200, body: '{"ok":true}' },
      ]);

      const response = await runWithTimers(
        client.get('/test', { maxRateLimitRetries: 4, retryDelayMs: 10 }),
      );

      expect(response.statusCode).toBe(200);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('returns 429 response after maxRateLimitRetries exhausted', async () => {
      setupMockResponses([
        { statusCode: 429, body: '{"error":"rate limited"}' },
        { statusCode: 429, body: '{"error":"rate limited"}' },
      ]);

      const response = await runWithTimers(
        client.get('/test', { maxRateLimitRetries: 1, maxRetries: 0, retryDelayMs: 10 }),
      );

      expect(response.statusCode).toBe(429);
    });
  });

  describe('5xx handling', () => {
    it('retries on 503 and succeeds', async () => {
      setupMockResponses([
        { statusCode: 503, body: '{}' },
        { statusCode: 200, body: '{"ok":true}' },
      ]);

      const response = await runWithTimers(
        client.get('/test', { maxRetries: 2, retryDelayMs: 10 }),
      );

      expect(response.statusCode).toBe(200);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on 400', async () => {
      setupMockResponses([
        { statusCode: 400, body: '{"error":"bad request"}' },
      ]);

      const response = await runWithTimers(
        client.get('/test', { maxRetries: 2, retryDelayMs: 10 }),
      );

      expect(response.statusCode).toBe(400);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 404', async () => {
      setupMockResponses([
        { statusCode: 404, body: '{}' },
      ]);

      const response = await runWithTimers(
        client.get('/test', { maxRetries: 2, retryDelayMs: 10 }),
      );

      expect(response.statusCode).toBe(404);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 500', async () => {
      setupMockResponses([
        { statusCode: 500, body: '{}' },
      ]);

      const response = await runWithTimers(
        client.get('/test', { maxRetries: 2, retryDelayMs: 10 }),
      );

      expect(response.statusCode).toBe(500);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('connection errors', () => {
    it('retries on connection error and succeeds', async () => {
      setupMockResponses([
        new Error('ECONNREFUSED'),
        { statusCode: 200, body: '{"ok":true}' },
      ]);

      const response = await runWithTimers(
        client.get('/test', { maxRetries: 2, retryDelayMs: 10 }),
      );

      expect(response.statusCode).toBe(200);
    });

    it('throws after all retries exhausted on connection error', async () => {
      setupMockResponses([
        new Error('ECONNREFUSED'),
        new Error('ECONNREFUSED'),
        new Error('ECONNREFUSED'),
      ]);

      await expect(
        runWithTimers(client.get('/test', { maxRetries: 1, maxRateLimitRetries: 1, retryDelayMs: 10 })),
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('path validation', () => {
    it('rejects paths with carriage return (\\r)', async () => {
      await expect(
        runWithTimers(client.get('/test\r/path', { maxRetries: 0, maxRateLimitRetries: 0 })),
      ).rejects.toThrow('Invalid request path');
    });

    it('rejects paths with newline (\\n)', async () => {
      await expect(
        runWithTimers(client.get('/test\n/path', { maxRetries: 0, maxRateLimitRetries: 0 })),
      ).rejects.toThrow('Invalid request path');
    });

    it('rejects paths with null byte (\\0)', async () => {
      await expect(
        runWithTimers(client.get('/test\0/path', { maxRetries: 0, maxRateLimitRetries: 0 })),
      ).rejects.toThrow('Invalid request path');
    });

    it('rejects paths with protocol injection (://)', async () => {
      await expect(
        runWithTimers(client.get('http://evil.com/path', { maxRetries: 0, maxRateLimitRetries: 0 })),
      ).rejects.toThrow('Invalid request path');
    });

    it('allows valid paths like /api/v1/resource', async () => {
      setupMockResponses([
        { statusCode: 200, body: '{"ok":true}' },
      ]);

      const response = await runWithTimers(
        client.get('/api/v1/resource', { maxRetries: 0 }),
      );

      expect(response.statusCode).toBe(200);
    });
  });

  describe('success on first try', () => {
    it('returns immediately without retries', async () => {
      setupMockResponses([
        { statusCode: 200, body: '{"data":"hello"}' },
      ]);

      const response = await runWithTimers(
        client.get('/test', { maxRetries: 2, retryDelayMs: 10 }),
      );

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ data: 'hello' });
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
  });
});
