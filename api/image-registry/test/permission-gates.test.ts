// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Authorization tests for the `/api/images` management surface.
 *
 * These routes were previously behind a single `requireSystemAdmin` blanket
 * gate; they're now permission-gated per operation:
 *   - reads  (GET list/tags/manifest/blob) → `registry:read`
 *   - writes (manifest/repo DELETE)         → `registry:write`
 *   - copy   (POST /copy; read+write)       → BOTH (`requireAllPermissions`)
 *
 * `registry:read`/`registry:write` are superadmin-only capabilities that no
 * built-in role bundles, so the effective access set is unchanged: a superadmin
 * (implicit-all) is the only holder. These tests pin that behavior — a
 * superadmin is allowed through each gate; an authenticated non-superadmin
 * (e.g. an org admin) whose permission set lacks `registry:*` is refused with
 * 403 — and, for copy, that holding only ONE of the two required perms is not
 * enough (the AND gate).
 *
 * The registry HTTP client and the framework plumbing are mocked (same style as
 * the sibling route suites); a tiny middleware seeds `req.user` from a header to
 * stand in for what `requireAuth` populates in production.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest, describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// --- registry-client mock (only the calls the happy-path handlers reach) ----
const listRepositories = jest.fn<() => Promise<{ repositories: string[] }>>();
const listTags = jest.fn<(name: string) => Promise<{ tags: string[] }>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ body: unknown; digest: string; mediaType: string }>>();
const headManifest = jest.fn<(name: string, ref: string) => Promise<{ digest: string } | null>>();
const mountBlob = jest.fn<(src: string, tgt: string, digest: string) => Promise<void>>();
const putManifest = jest.fn<(name: string, ref: string, body: unknown, mediaType: string) => Promise<void>>();
const isNotFound = (e: unknown): boolean => (e as { statusCode?: number })?.statusCode === 404;

jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositories,
  listTags,
  getManifest,
  headManifest,
  mountBlob,
  putManifest,
  deleteManifest: jest.fn(),
  headBlob: jest.fn(),
  getBlobStream: jest.fn(),
  isNotFound,
}));

// --- api-server mock: withRoute passthrough + metric counter ----------------
const incCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx, orgId: '000000000000000000000001', userId: 'admin' });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      if (!r.headersSent) r.status(status).json({ success: false, message: (err as Error)?.message });
    }
  },
  incCounter,
}));

// --- api-core mock: real-enough send helpers + the capability-aware gates ----
// (`requirePermission`/`requireAllPermissions` come from the shared helper.)
const emitAudit = jest.fn();
type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendError: (res: Res, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  sendEntityNotFound: (res: Res, entity: string) => res.status(404).json({ success: false, message: `${entity} not found` }),
  getParam: (params: Record<string, string>, key: string) => params[key],
  parsePaginationParams: (q: Record<string, unknown>) => ({ limit: q.limit ? Number(q.limit) : 100 }),
  runConcurrent: async <T>(items: T[], _n: number, fn: (t: T) => Promise<void>) => {
    for (const item of items) await fn(item);
  },
  emitAudit,
}));

// SUT + express imported AFTER mocks are registered (ESM linking order).
const express = (await import('express')).default;
const { createImageRoutes } = await import('../src/routes/images.js');

let server: Server;
let baseUrl: string;

// Header-driven identities standing in for what requireAuth would attach.
const USERS: Record<string, { isSuperAdmin?: boolean; permissions?: string[] } | undefined> = {
  // Implicit-all: holds every permission, including registry:*.
  super: { isSuperAdmin: true },
  // Authenticated org admin — real perms, but NOT registry:read/write.
  admin: { isSuperAdmin: false, permissions: ['org:read', 'org:write', 'pipeline:read', 'pipeline:write'] },
  // Holds ONLY registry:read — enough for reads, not for copy's AND gate.
  reader: { isSuperAdmin: false, permissions: ['registry:read'] },
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for requireAuth: seed req.user from the x-test-user header so the
  // permission gates have an identity to evaluate (matches production ordering,
  // where requireAuth runs before the router — see src/index.ts).
  app.use((req, _res, next) => {
    const who = req.headers['x-test-user'];
    const user = typeof who === 'string' ? USERS[who] : undefined;
    if (user) (req as { user?: unknown }).user = user;
    next();
  });
  app.use('/api/images', createImageRoutes());
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  // Happy-path registry responses so an allowed request reaches a clean 200.
  listRepositories.mockResolvedValue({ repositories: [] });
  listTags.mockResolvedValue({ tags: [] });
  getManifest.mockResolvedValue({
    body: { config: { digest: 'sha256:cfg' }, layers: [] },
    digest: 'sha256:src',
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
  });
  headManifest.mockResolvedValue(null);
  mountBlob.mockResolvedValue(undefined);
  putManifest.mockResolvedValue(undefined);
});

const req = async (
  method: string,
  path: string,
  who: string | undefined,
  body?: unknown,
) => {
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

describe('registry:read gate — GET /api/images (representative read)', () => {
  it('allows a superadmin (implicit-all)', async () => {
    const { status, body } = await req('GET', '/api/images', 'super');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(listRepositories).toHaveBeenCalled();
  });

  it('rejects an authenticated non-superadmin without registry:read (403)', async () => {
    const { status, body } = await req('GET', '/api/images', 'admin');
    expect(status).toBe(403);
    expect(body.message).toMatch(/registry:read/);
    // Gate short-circuits before the handler touches the registry.
    expect(listRepositories).not.toHaveBeenCalled();
  });
});

describe('registry:write gate — DELETE /api/images/:name (representative write)', () => {
  it('allows a superadmin (implicit-all)', async () => {
    const { status } = await req('DELETE', '/api/images/library%2Ffoo', 'super');
    expect(status).toBe(200);
  });

  it('rejects an authenticated non-superadmin without registry:write (403)', async () => {
    const { status, body } = await req('DELETE', '/api/images/library%2Ffoo', 'admin');
    expect(status).toBe(403);
    expect(body.message).toMatch(/registry:write/);
    expect(listTags).not.toHaveBeenCalled();
  });

  it('rejects a holder of only registry:read (403 — read does not grant write)', async () => {
    const { status, body } = await req('DELETE', '/api/images/library%2Ffoo', 'reader');
    expect(status).toBe(403);
    expect(body.message).toMatch(/registry:write/);
    expect(listTags).not.toHaveBeenCalled();
  });
});

describe('registry:read AND registry:write gate — POST /api/images/copy', () => {
  const copyBody = { source: 'library/foo:1.0', target: 'library/bar:1.0' };

  it('allows a superadmin (implicit-all holds both)', async () => {
    const { status, body } = await req('POST', '/api/images/copy', 'super', copyBody);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('rejects an authenticated non-superadmin holding neither perm (403)', async () => {
    const { status, body } = await req('POST', '/api/images/copy', 'admin', copyBody);
    expect(status).toBe(403);
    expect(body.message).toMatch(/registry:read and registry:write/);
    expect(getManifest).not.toHaveBeenCalled();
  });

  it('rejects a holder of only registry:read (403 — AND gate needs write too)', async () => {
    const { status, body } = await req('POST', '/api/images/copy', 'reader', copyBody);
    expect(status).toBe(403);
    // The message names the missing perm (write), not the held one.
    expect(body.message).toMatch(/registry:write/);
    expect(getManifest).not.toHaveBeenCalled();
  });
});
