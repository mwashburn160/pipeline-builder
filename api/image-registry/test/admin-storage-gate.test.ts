// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authorization tests for the /api/admin storage rollup route.
 *
 * `GET /api/admin/storage/:prefix` is a READ — it computes a per-namespace
 * byte rollup and mutates nothing — so it is gated on `registry:read`, matching
 * the image read routes. The manual GC (`POST /api/admin/gc`) is a PURGE: it
 * deletes manifests across a whole namespace, so it takes `registry:purge`,
 * which is superadmin-only and in no Role bundle.
 *
 * The rollup ALSO applies `canReadRepo` to the requested namespace, and that is
 * not belt-and-braces: `registry:read` is carried by Roles now (Platform
 * Operator, Platform Observer, Registry Operator), and a byte total for
 * `org-acme/` is a fact about another tenant. A non-superadmin holder sees the
 * shared namespaces and its own, and nothing else — pinned below.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest, describe, it, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// --- service mocks (the two handlers' only backend calls) -------------------
const computeStorageUsage = jest.fn<() => Promise<{ bytes: number; incomplete?: boolean }>>();
const runRegistryGc = jest.fn<() => Promise<{ reposScanned: number; candidates: number; deleted: number }>>();

jest.unstable_mockModule('../src/services/storage-usage.js', () => ({ computeStorageUsage }));
jest.unstable_mockModule('../src/services/registry-gc.js', () => ({ runRegistryGc }));

// --- api-server mock: withRoute passthrough ---------------------------------
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn<AnyFn>(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      if (!r.headersSent) r.status(500).json({ success: false, message: (err as Error)?.message });
    }
  },
  incCounter: jest.fn<AnyFn>(),
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

/**
 * The system org id `requireSystemOrg` accepts, and the three claims
 * `requireAssurance({ minAssurance: 2 })` needs. `registry:read`/`:write` are
 * system-org-only, so `requireSystemOrgPermission` composes all of it around
 * the permission — and `isHumanPrincipal` demands BOTH `principalType: 'user'`
 * and `token_use: 'access'`, so a fixture missing either is refused as a MACHINE
 * principal, not for the permission the test is about.
 */
const SYSTEM_ORG = '000000000000000000000001';
const MFA_SESSION = { organizationId: SYSTEM_ORG, aal: 2, principalType: 'user' as const, token_use: 'access' as const };

const USERS: Record<string, Record<string, unknown> | undefined> = {
  super: { ...MFA_SESSION, isSuperAdmin: true },
  admin: { ...MFA_SESSION, isSuperAdmin: false, permissions: ['org:read', 'org:write'] },
  reader: { ...MFA_SESSION, isSuperAdmin: false, permissions: ['registry:read'] },
  promoter: { ...MFA_SESSION, isSuperAdmin: false, permissions: ['registry:read', 'registry:write'] },
  purger: { ...MFA_SESSION, isSuperAdmin: false, permissions: ['registry:purge'] },
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
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
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

  it('allows a holder of registry:read on a SHARED namespace', async () => {
    const { status, body } = await req('GET', '/api/admin/storage/system', 'reader');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(computeStorageUsage).toHaveBeenCalled();
  });

  it('rejects a non-superadmin lacking registry:read (403)', async () => {
    const { status, body } = await req('GET', '/api/admin/storage/system', 'admin');
    expect(status).toBe(403);
    expect(body.message).toMatch(/registry:read/);
    expect(computeStorageUsage).not.toHaveBeenCalled();
  });

  // The namespace filter, which the permission alone does not provide. This is
  // the case that `registry:read`'s promotion out of superadmin-only opened: the
  // holder passes the gate and must still be refused another tenant's bytes.
  it("rejects a registry:read holder asking for ANOTHER tenant's namespace (403)", async () => {
    const { status, body } = await req('GET', '/api/admin/storage/org-acme', 'reader');
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
    expect(computeStorageUsage).not.toHaveBeenCalled();
  });
});

describe('registry:purge gate — POST /api/admin/gc (the prune has no undo)', () => {
  const gcBody = { prefix: 'org-acme/' };

  it('allows a superadmin', async () => {
    const { status } = await req('POST', '/api/admin/gc', 'super', gcBody);
    expect(status).toBe(200);
    expect(runRegistryGc).toHaveBeenCalled();
  });

  it('rejects a registry:read-only holder (403 — read does not grant GC)', async () => {
    const { status, body } = await req('POST', '/api/admin/gc', 'reader', gcBody);
    expect(status).toBe(403);
    expect(body.message).toMatch(/registry:purge/);
    expect(runRegistryGc).not.toHaveBeenCalled();
  });

  it('rejects a Registry Operator — copying an image is not deleting one (403)', async () => {
    const { status, body } = await req('POST', '/api/admin/gc', 'promoter', gcBody);
    expect(status).toBe(403);
    expect(body.message).toMatch(/registry:purge/);
    expect(runRegistryGc).not.toHaveBeenCalled();
  });

  // `registry:purge` is superadmin-only, so no bundle carries it; a hand-built
  // holder still passes, which is what keeps the gate honest rather than
  // accidentally flag-only.
  it('allows a non-superadmin holding registry:purge', async () => {
    const { status } = await req('POST', '/api/admin/gc', 'purger', gcBody);
    expect(status).toBe(200);
    expect(runRegistryGc).toHaveBeenCalled();
  });
});
