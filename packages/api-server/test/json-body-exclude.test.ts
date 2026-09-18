// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression lock for the Stripe raw-body wiring (`createApp({ jsonBodyExclude })`).
 *
 * The billing service mounts `express.raw()` on `/billing/stripe/webhook` and
 * relies on `createApp({ jsonBodyExclude: ['/billing/stripe/webhook'] })` to skip
 * the GLOBAL `express.json()` on that path. If the global parser ran first,
 * `req.body` would be a PARSED OBJECT, Stripe's `constructEvent` would get an
 * object instead of the exact bytes, and signature verification would 400 EVERY
 * real webhook delivery — while the handler-level unit test (which hands the
 * handler a Buffer directly) stayed green.
 *
 * This drives real HTTP through the REAL `createApp` and asserts an excluded path
 * receives the exact raw Buffer, while a non-excluded path is still JSON-parsed.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';

process.env.NODE_ENV = 'test';

// createLogger stub avoids Winston open handles; keep the rest of api-core real.
const actualApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  ...actualApiCore,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.unstable_mockModule('uuid', () => ({ v7: () => '00000000-0000-0000-0000-000000000000' }));

const { createApp } = await import('../src/api/app-factory.js');

describe('createApp jsonBodyExclude — Stripe raw-body contract', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const { app } = createApp({
      enableRateLimit: false,
      enableOpenApi: false,
      enableHelmet: false,
      jsonBodyExclude: ['/hook'],
    });
    // Excluded path — a per-path express.raw() must see the EXACT bytes (a Buffer).
    app.post('/hook', express.raw({ type: '*/*' }), (req, res) => {
      res.json({
        isBuffer: Buffer.isBuffer(req.body),
        raw: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null,
      });
    });
    // Non-excluded path — the global express.json() still parses to an object.
    app.post('/json', (req, res) => {
      res.json({ parsed: req.body });
    });
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('delivers the EXACT raw bytes (a Buffer) to an excluded path', async () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const res = await fetch(`${base}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { isBuffer: boolean; raw: string | null };
    // The whole point: a Buffer with the exact bytes. A parsed object here would
    // be the regression that breaks every real Stripe delivery.
    expect(body.isBuffer).toBe(true);
    expect(body.raw).toBe(payload);
  });

  it('still JSON-parses a NON-excluded path (global parser intact)', async () => {
    const res = await fetch(`${base}/json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1, b: [2, 3] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { parsed: unknown };
    expect(body.parsed).toEqual({ a: 1, b: [2, 3] });
  });
});
