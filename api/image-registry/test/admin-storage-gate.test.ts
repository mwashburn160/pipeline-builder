// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authorization tests for the /api/admin storage rollup route.
 *
 * `GET /api/admin/storage/:prefix` is a READ — it computes a per-namespace
 * byte rollup and mutates nothing. It is therefore gated on `registry:read`
 * (previously mislabeled as `registry:write`), matching the image read routes.
 * The manual GC (`POST /api/admin/gc`) stays a `registry:write` operation.
 *
 * Both perms are superadmin-only, so the effective access set is unchanged;
 * these tests pin the corrected gate: a `registry:read`-only holder can now
 * reach the storage rollup, a non-holder is refused 403, and the GC prune
 * still needs `registry:write` (a read-only holder is refused there).
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// --- service mocks (the two handlers' only backend calls) -------------------
const computeStorageUsage = jest.fn<() => Promise<{ bytes: number; incomplete?: boolean }>>();
const runRegistryGc = jest.fn<() => Promise<{ reposScanned: number; candidates: number; deleted: number }>>();

jest.unstable_mockModule('../src/services/storage-usage.js', () => ({ computeStorageUsage }));
jest.unstable_mockModule('../src/services/registry-gc.js', () => ({ runRegistryGc }));

// --- api-server mock: withRoute passthrough ---------------------------------
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      if (!r.headersSent) r.status(500).json({ success: false, message: (err as Error)?.message });
    }
  },
  incCounter: jest.fn(),
}));

// --- api-core mock: send helpers + capability-aware gates --------------------
type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  getParam: (params: Record<string, string>, key: string) => params[key],
}));

const express = (await import('express')).default;
const { createAdminRoutes } = await import('../src/routes/admin.js');

let server: Server;
let baseUrl: string;

const USERS: Record<string, { isSuperAdmin?: boolean; permissions?: string[] } | undefined> = {
  super: { isSuperAdmin: true },
  admin: { isSuperAdmin: false, permissions: ['org:read', 'org:write'] },
  reader: { isSuperAdmin: false, permissions: ['registry:read'] },
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    const user = typeof who === 'string' ? USERS[who] : undefined;
    if (user) (req as { user?: unknown }).user = user;
    next();
  });
  app.use('/api/admin', createAdminRoutes());
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  computeStorageUsage.mockResolvedValue({ bytes: 123 });
  runRegistryGc.mockResolvedValue({ reposScanned: 0, candidates: 0, deleted: 0 });
});

const req = async (method: string, path: string, who: string | undefined, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(who ? { 'x-test-user': who } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('registry:read gate — GET /api/admin/storage/:prefix (rollup is a READ)', () => {
  it('allows a superadmin (implicit-all)', async () => {
    const { status, body } = await req('GET', '/api/admin/storage/org-acme', 'super');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(computeStorageUsage).toHaveBeenCalled();
  });

  it('allows a holder of registry:read (the corrected gate)', async () => {
    const { status, body } = await req('GET', '/api/admin/storage/org-acme', 'reader');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(computeStorageUsage).toHaveBeenCalled();
  });

  it('rejects a non-superadmin lacking registry:read (403)', async () => {
    const { status, body } = await req('GET', '/api/admin/storage/org-acme', 'admin');
    expect(status).toBe(403);
    expect(body.message).toMatch(/registry:read/);
    expect(computeStorageUsage).not.toHaveBeenCalled();
  });
});

describe('registry:write gate — POST /api/admin/gc (prune is a WRITE)', () => {
  const gcBody = { prefix: 'org-acme/' };

  it('allows a superadmin', async () => {
    const { status } = await req('POST', '/api/admin/gc', 'super', gcBody);
    expect(status).toBe(200);
    expect(runRegistryGc).toHaveBeenCalled();
  });

  it('rejects a registry:read-only holder (403 — read does not grant GC)', async () => {
    const { status, body } = await req('POST', '/api/admin/gc', 'reader', gcBody);
    expect(status).toBe(403);
    expect(body.message).toMatch(/registry:write/);
    expect(runRegistryGc).not.toHaveBeenCalled();
  });
});
