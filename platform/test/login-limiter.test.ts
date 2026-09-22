// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The PER-ACCOUNT password sign-in throttle: keyed on the hashed, normalized
 * identifier (so rotating source IPs doesn't reset it), counting only FAILED
 * attempts (so the owner's successful sign-ins never consume it).
 */

import type { AddressInfo } from 'net';
import { jest, describe, it, expect, afterAll, beforeAll } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import express from 'express';
import { mockConfig } from './helpers/config-mock.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ auth: { loginThrottle: { perAccountMax: 3, perAccountWindowMs: 60_000 } } }));
// No Redis in the suite: express-rate-limit falls back to its in-memory store.
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { createSharedRateLimitStore: () => undefined }));

const { loginAccountKey, loginAccountLimiter } = await import('../src/middleware/login-limiter.js');

let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.use('/login', loginAccountLimiter);
  // Stand-in for the login handler: the right password answers 200.
  app.post('/login', (req, res) => {
    if (req.body.password === 'right') res.status(200).json({ ok: true });
    else res.status(401).json({ ok: false });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const attempt = (identifier: string, password: string) => fetch(`${base}/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier, password }),
}).then((r) => r.status);

describe('loginAccountKey', () => {
  it('hashes the trimmed, lowercased identifier — never the raw value', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const key = loginAccountKey({ body: { identifier: '  Alice@Example.com ' } } as any);
    expect(key).toBe(loginAccountKey({ body: { identifier: 'alice@example.com' } } as any));
    expect(key).toMatch(/^a:[0-9a-f]{64}$/);
    expect(key).not.toContain('alice');
  });
});

describe('loginAccountLimiter', () => {
  it('successful sign-ins never consume the bucket', async () => {
    for (let i = 0; i < 5; i += 1) expect(await attempt('owner@example.com', 'right')).toBe(200);
  });

  it('refuses the account after the failed-attempt budget, whatever the casing', async () => {
    expect(await attempt('victim@example.com', 'wrong')).toBe(401);
    expect(await attempt('Victim@example.com', 'wrong')).toBe(401);
    expect(await attempt(' victim@EXAMPLE.com', 'wrong')).toBe(401);
    expect(await attempt('victim@example.com', 'wrong')).toBe(429);
    // Even the right password waits out the window once the account is throttled.
    expect(await attempt('victim@example.com', 'right')).toBe(429);
    // Another account is unaffected.
    expect(await attempt('bystander@example.com', 'wrong')).toBe(401);
  });
});
