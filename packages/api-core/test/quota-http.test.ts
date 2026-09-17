// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end over a real socket (real http-client, no mocks): an over-quota
 * reserve must come back as `exceeded` IMMEDIATELY. The quota service answers
 * 429 with `Retry-After` = seconds to the period reset; retrying it stalled the
 * request past the handler timeout, which then turned the 429 into a 503.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createQuotaService } from '../src/services/quota.js';
import { sendQuotaExceeded } from '../src/utils/response.js';

describe('quota reserve against a real HTTP 429', () => {
  let server: http.Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      // Shape the response exactly as the quota service does (sendQuotaExceeded).
      const expressLike = {
        headersSent: false,
        setHeader: (k: string, v: unknown) => res.setHeader(k, String(v)),
        status(code: number) { res.statusCode = code; return this; },
        json(body: unknown) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return this; },
      };
      const resetAt = new Date(Date.now() + 45_000).toISOString();
      sendQuotaExceeded(expressLike as never, 'pipelines', { limit: 5, used: 5, remaining: 0 } as never, resetAt);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('returns exceeded (not unavailable) on the first 429 without retrying', async () => {
    const quota = createQuotaService({ host: '127.0.0.1', port, timeout: 2_000 });
    const started = Date.now();
    const result = await quota.reserve('org-1', 'pipelines', 'Bearer x');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hits).toBe(1);
    expect(result.exceeded).toBe(true);
    expect(result.unavailable).toBeUndefined();
    expect(result.quota).toMatchObject({ limit: 5, used: 5 });
  }, 10_000);
});
