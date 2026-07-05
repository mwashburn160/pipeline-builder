// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route tests for `DELETE /api/images/:name` — the "prune an entire
 * repository" endpoint the registry UI calls to remove empty/dead repos.
 *
 * The framework plumbing (`withRoute`, `requireSystemAdmin`, the `send*`
 * helpers) and the registry HTTP client are mocked so the test isolates the
 * handler's own logic: tag→digest resolution, digest dedup, idempotent
 * delete, the already-empty short-circuit, and the audit/metric side effects.
 * The router is mounted on a real Express app and driven over HTTP via the
 * built-in `fetch`, so param decoding (`library%2Ffoo` → `library/foo`) is
 * exercised exactly as in production.
 */

import { jest } from '@jest/globals';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { apiCoreMock } from './helpers/mock-api-core.js';

// --- registry-client mock (the backing registry HTTP calls) ---------------
const listRepositories = jest.fn();
const listTags = jest.fn<(name: string) => Promise<{ tags: string[] }>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ digest: string }>>();
const deleteManifest = jest.fn<(name: string, digest: string) => Promise<void>>();
const isNotFound = (e: unknown): boolean => (e as { statusCode?: number })?.statusCode === 404;

jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositories,
  listTags,
  getManifest,
  deleteManifest,
  putManifest: jest.fn(),
  headManifest: jest.fn(),
  headBlob: jest.fn(),
  getBlobStream: jest.fn(),
  mountBlob: jest.fn(),
  isNotFound,
}));

// --- api-server mock: withRoute passthrough + metric counter ---------------
const incCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  // Passthrough that hands the handler a minimal ctx and mirrors withRoute's
  // "unhandled throw → 500" contract so thrown (non-NotFound) errors surface
  // as 500 exactly like production.
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx, orgId: 'system', userId: 'admin' });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      if (!r.headersSent) r.status(status).json({ success: false, message: (err as Error)?.message });
    }
  },
  incCounter,
}));

// --- api-core mock: real-enough send helpers + utilities -------------------
const emitAudit = jest.fn();
type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendError: (res: Res, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  sendEntityNotFound: (res: Res, entity: string) => res.status(404).json({ success: false, message: `${entity} not found` }),
  getParam: (params: Record<string, string>, key: string) => params[key],
  requireSystemAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  parsePaginationParams: (q: Record<string, unknown>) => ({ limit: q.limit ? Number(q.limit) : 100 }),
  // Sequential stand-in for the concurrency helper — deterministic, and the
  // handler only relies on side effects, not on parallelism.
  runConcurrent: async <T>(items: T[], _n: number, fn: (t: T) => Promise<void>) => {
    for (const it of items) await fn(it);
  },
  emitAudit,
}));

// SUT + express imported AFTER mocks are registered (ESM linking order).
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

const del = async (name: string) => {
  const res = await fetch(`${baseUrl}/api/images/${encodeURIComponent(name)}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('DELETE /api/images/:name', () => {
  it('short-circuits an already-empty repo (0 tags) without deleting or emitting a metric', async () => {
    listTags.mockResolvedValue({ tags: [] });

    const { status, body } = await del('library/pipeline-snyk-base');

    expect(status).toBe(200);
    expect(body.data).toEqual({
      name: 'library/pipeline-snyk-base',
      deletedManifests: 0,
      deletedTags: 0,
      alreadyEmpty: true,
    });
    expect(deleteManifest).not.toHaveBeenCalled();
    // No work done → no audit, no metric.
    expect(emitAudit).not.toHaveBeenCalled();
    expect(incCounter).not.toHaveBeenCalled();
  });

  it('dedupes digests: two tags sharing a digest delete one manifest, reports both tags', async () => {
    listTags.mockResolvedValue({ tags: ['1.0', 'latest', '2.0'] });
    // 1.0 and latest point at the same digest; 2.0 is distinct.
    const digests: Record<string, string> = { '1.0': 'sha256:aaa', latest: 'sha256:aaa', '2.0': 'sha256:bbb' };
    getManifest.mockImplementation(async (_name, ref) => ({ digest: digests[ref] }));
    deleteManifest.mockResolvedValue(undefined);

    const { status, body } = await del('org-acme/api');

    expect(status).toBe(200);
    expect(body.data).toEqual({ name: 'org-acme/api', deletedManifests: 2, deletedTags: 3 });
    // Two UNIQUE digests deleted, not three tags.
    expect(deleteManifest).toHaveBeenCalledTimes(2);
    const deletedDigests = deleteManifest.mock.calls.map((c) => c[1]).sort();
    expect(deletedDigests).toEqual(['sha256:aaa', 'sha256:bbb']);
    // Repo-name is URL-decoded back to its `/`-containing form for every call.
    expect(deleteManifest.mock.calls.every((c) => c[0] === 'org-acme/api')).toBe(true);
    expect(incCounter).toHaveBeenCalledWith('registry_repo_delete_total');
    expect(emitAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'registry.repo.delete',
        repo: 'org-acme/api',
        deletedManifests: 2,
        deletedTags: 3,
      }),
    );
  });

  it('returns 404 when the repo itself does not exist (listTags 404)', async () => {
    listTags.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));

    const { status, body } = await del('org-acme/missing');

    expect(status).toBe(404);
    expect(body.message).toMatch(/not found/i);
    expect(deleteManifest).not.toHaveBeenCalled();
    expect(incCounter).not.toHaveBeenCalled();
  });

  it('is idempotent: a digest that 404s on delete is skipped, others still counted', async () => {
    listTags.mockResolvedValue({ tags: ['a', 'b'] });
    getManifest.mockImplementation(async (_name, ref) => ({ digest: ref === 'a' ? 'sha256:aaa' : 'sha256:bbb' }));
    deleteManifest.mockImplementation(async (_name, digest) => {
      if (digest === 'sha256:aaa') throw Object.assign(new Error('gone'), { statusCode: 404 });
    });

    const { status, body } = await del('org-acme/racey');

    expect(status).toBe(200);
    // Only the one that actually deleted is counted; both tags reported.
    expect(body.data).toEqual({ name: 'org-acme/racey', deletedManifests: 1, deletedTags: 2 });
    expect(incCounter).toHaveBeenCalledWith('registry_repo_delete_total');
  });

  it('propagates a non-NotFound delete error as 500', async () => {
    listTags.mockResolvedValue({ tags: ['x'] });
    getManifest.mockResolvedValue({ digest: 'sha256:xxx' });
    deleteManifest.mockRejectedValue(Object.assign(new Error('registry 500'), { statusCode: 500 }));

    const { status } = await del('org-acme/boom');

    expect(status).toBe(500);
    // A failed prune must NOT emit a success metric.
    expect(incCounter).not.toHaveBeenCalled();
  });
});
