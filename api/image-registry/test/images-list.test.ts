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
import { jest } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const listRepositories = jest.fn<() => Promise<{ repositories: string[] }>>();
const listTags = jest.fn<(name: string) => Promise<{ name: string; tags: string[] }>>();
const getManifest = jest.fn();
const isNotFound = (e: unknown): boolean => (e as { statusCode?: number })?.statusCode === 404;

jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositories,
  listTags,
  getManifest,
  deleteManifest: jest.fn(),
  putManifest: jest.fn(),
  headManifest: jest.fn(),
  headBlob: jest.fn(),
  getBlobStream: jest.fn(),
  mountBlob: jest.fn(),
  isNotFound,
}));

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
  incCounter: jest.fn(),
}));

type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendError: (res: Res, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  emitAudit: () => {},
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendEntityNotFound: (res: Res, entity: string) => res.status(404).json({ success: false, message: `${entity} not found` }),
  getParam: (params: Record<string, string>, key: string) => params[key],
  parsePaginationParams: (q: Record<string, unknown>) => ({ limit: q.limit ? Number(q.limit) : 100 }),
  runConcurrent: async <T>(items: T[], _n: number, fn: (t: T) => Promise<void>) => {
    for (const it of items) await fn(it);
  },
}));

const express = (await import('express')).default;
const { createImageRoutes } = await import('../src/routes/images.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/images', createImageRoutes());
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => jest.clearAllMocks());

const getTags = async (name: string) => {
  const res = await fetch(`${baseUrl}/api/images/${encodeURIComponent(name)}/tags`);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('GET /api/images/:name/tags', () => {
  it('returns 404 (not 500) when the repo does not exist (listTags 404)', async () => {
    listTags.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));

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

  it('propagates a non-NotFound registry error (not swallowed as 404)', async () => {
    // The error carries its own statusCode (503) — the handler must NOT convert it
    // to 404; it re-throws so the error's status propagates.
    listTags.mockRejectedValue(Object.assign(new Error('registry 503'), { statusCode: 503 }));

    const { status } = await getTags('org-acme/boom');

    expect(status).toBe(503);
  });
});
