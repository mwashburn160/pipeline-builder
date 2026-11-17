// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route tests for the read-only listing routes, focused on
 * `GET /api/images/:name/tags` error mapping: a missing repo must surface as
 * a clean 404 (like the sibling manifest route), NOT a raw 500 from the
 * unhandled axios error.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest, beforeAll, afterAll, beforeEach, describe, it, expect } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const listRepositories = jest.fn<(o?: { n?: number; last?: string }) => Promise<{ repositories: string[]; next?: string }>>();
const listTags = jest.fn<(name: string) => Promise<{ name: string; tags: string[] }>>();
const getManifest = jest.fn<AnyFn>();
const isNotFound = (e: unknown): boolean => (e as { response?: { status?: number } })?.response?.status === 404;

// The delete routes evict the storage caches; the real module needs registry calls this suite does not mock.
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({ invalidateStorageCache: jest.fn(), invalidateOrgStorageCache: jest.fn() }));
jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositories,
  listTags,
  getManifest,
  deleteManifest: jest.fn<AnyFn>(),
  putManifest: jest.fn<AnyFn>(),
  headManifest: jest.fn<AnyFn>(),
  headBlob: jest.fn<AnyFn>(),
  getBlobStream: jest.fn<AnyFn>(),
  mountBlob: jest.fn<AnyFn>(),
  isNotFound,
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn<AnyFn>(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx, orgId: '000000000000000000000001', userId: 'admin' });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      if (!r.headersSent) r.status(status).json({ success: false, message: (err as Error)?.message });
    }
  },
  incCounter: jest.fn<AnyFn>(),
}));

type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendError: (res: Res, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  logAuditEvent: () => {},
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendEntityNotFound: (res: Res, entity: string) => res.status(404).json({ success: false, message: `${entity} not found` }),
  getParam: (params: Record<string, string>, key: string) => params[key],
  parsePaginationParams: (q: Record<string, unknown>) => ({ limit: q.limit ? Number(q.limit) : 100 }),
  runConcurrent: async <T>(items: T[], _n: number, fn: (t: T) => Promise<void>) => {
    for (const item of items) await fn(item);
  },
}));

const express = (await import('express')).default;
const { createImageRoutes } = await import('../src/routes/images.js');
const { encodeCatalogCursor, decodeCatalogCursor } = await import('../src/routes/images/images-list.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for requireAuth (which always runs before these routes in prod):
  // seed a superadmin req.user so the per-repo org-ownership gate passes and the
  // suite can focus on the routes' own error-mapping logic.
  app.use((req, _res, next) => {
    // The real gate chain runs here: `requireSystemOrgPermission` composes
    // requireSystemOrg + the permission + `requireAssurance({ minAssurance: 2 })`.
    // So the fixture carries four claims beyond the identity — the system org
    // (the default SYSTEM_ORG_ID), `aal: 2`, and `principalType` + `token_use`,
    // without which `isHumanPrincipal` refuses it as a MACHINE principal rather
    // than for a weak session.
    (req as { user?: unknown }).user = {
      isSuperAdmin: true,
      sub: 'admin',
      organizationId: '000000000000000000000001',
      aal: 2,
      principalType: 'user',
      token_use: 'access',
    };
    next();
  });
  app.use('/api/images', createImageRoutes());
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => { jest.clearAllMocks(); });

const getTags = async (name: string) => {
  const res = await fetch(`${baseUrl}/api/images/${encodeURIComponent(name)}/tags`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('GET /api/images/:name/tags', () => {
  it('returns 404 (not 500) when the repo does not exist (listTags 404)', async () => {
    listTags.mockRejectedValue(Object.assign(new Error('not found'), { response: { status: 404 } }));

    const { status, body } = await getTags('org-acme/missing');

    expect(status).toBe(404);
    expect(body.message).toMatch(/image not found/i);
  });

  it('returns 200 with the tag list for an existing repo', async () => {
    listTags.mockResolvedValue({ name: 'org-acme/app', tags: ['1.0', 'latest'] });

    const { status, body } = await getTags('org-acme/app');

    expect(status).toBe(200);
    expect(body.data).toEqual({ name: 'org-acme/app', tags: ['1.0', 'latest'] });
  });

  it('hides cosign signature/attestation tags — they describe an image, they are not one', async () => {
    const hex = 'a'.repeat(64);
    listTags.mockResolvedValue({ name: 'org-acme/app', tags: ['1.0', `sha256-${hex}.sig`, `sha256-${hex}.att`] });

    const { body } = await getTags('org-acme/app');

    expect(body.data).toEqual({ name: 'org-acme/app', tags: ['1.0'] });
  });

  it('propagates a non-NotFound registry error (not swallowed as 404)', async () => {
    // The error carries its own statusCode (503) — the handler must NOT convert it
    // to 404; it re-throws so the error's status propagates.
    listTags.mockRejectedValue(Object.assign(new Error('registry 503'), { statusCode: 503 }));

    const { status } = await getTags('org-acme/boom');

    expect(status).toBe(503);
  });
});

// The catalog cursor is OPAQUE: Distribution pages by the last repository name,
// which is frequently one the caller may not read (the page is filtered per org
// after the registry answers), so `next` must not hand that name out.
describe('GET /api/images — opaque cursor', () => {
  const list = async (q = '') => {
    const res = await fetch(`${baseUrl}/api/images${q}`);
    return { status: res.status, body: await res.json() as { data?: { repositories: string[]; next?: string } } };
  };

  it('returns `next` as an opaque cursor, never the raw repository name', async () => {
    listRepositories.mockResolvedValue({ repositories: ['org-acme/app'], next: 'org-zzz/secret' });
    const { status, body } = await list('?limit=1');
    expect(status).toBe(200);
    expect(body.data!.next).toBe(encodeCatalogCursor('org-zzz/secret'));
    expect(body.data!.next).not.toContain('org-zzz');
  });

  it('decodes the cursor sent back into the registry `last`', async () => {
    listRepositories.mockResolvedValue({ repositories: [] });
    await list(`?cursor=${encodeURIComponent(encodeCatalogCursor('org-zzz/secret'))}`);
    expect(listRepositories).toHaveBeenCalledWith(expect.objectContaining({ last: 'org-zzz/secret' }));
  });

  it('refuses a cursor it did not issue (400), without calling the registry', async () => {
    const { status } = await list('?cursor=org-zzz/secret');
    expect(status).toBe(400);
    expect(listRepositories).not.toHaveBeenCalled();
  });

  it('round-trips names and rejects a forged payload', () => {
    expect(decodeCatalogCursor(encodeCatalogCursor('org-a/b.c_d-e/f'))).toBe('org-a/b.c_d-e/f');
    expect(decodeCatalogCursor(`c1.${Buffer.from('../etc?x=1').toString('base64url')}`)).toBeNull();
    expect(decodeCatalogCursor('nope')).toBeNull();
  });
});
