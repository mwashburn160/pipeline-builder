// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Functional tests for POST /api/images/copy.
 *
 * Covers the behaviours the copy path had NO coverage for:
 *   - per-repo org-ownership scoping (a tenant can't read/write another tenant's
 *     repo, independent of the registry:read/write perm gate);
 *   - the explicit cross-tenant opt-in guard;
 *   - single-arch and multi-arch (index) copy happy paths;
 *   - overwrite conflict (target tag exists with a different digest);
 *   - the durable audit emission (registry.image.copy) on success.
 *
 * The registry HTTP client, the audit sink, and the framework plumbing are
 * mocked (same style as permission-gates.test.ts); a tiny middleware seeds
 * req.user from a header to stand in for what requireAuth populates.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest, describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

// --- registry-client mock ---------------------------------------------------
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ body: unknown; digest: string; mediaType: string }>>();
const headManifest = jest.fn<(name: string, ref: string) => Promise<{ digest: string } | null>>();
const mountBlob = jest.fn<(src: string, tgt: string, digest: string) => Promise<void>>();
const putManifest = jest.fn<(name: string, ref: string, body: unknown, mediaType: string) => Promise<void>>();
const isNotFound = (e: unknown): boolean => (e as { statusCode?: number })?.statusCode === 404;

jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositories: jest.fn(),
  listTags: jest.fn(),
  getManifest,
  headManifest,
  mountBlob,
  putManifest,
  deleteManifest: jest.fn(),
  headBlob: jest.fn(),
  getBlobStream: jest.fn(),
  isNotFound,
}));

// --- durable-audit mock (assert registry.image.copy is emitted) -------------
const emitImageRegistryAudit = jest.fn();
jest.unstable_mockModule('../src/services/audit.js', () => ({
  emitImageRegistryAudit,
  getAuditClient: () => ({ record: jest.fn() }),
}));

// --- api-server mock: withRoute passthrough + metric counter ----------------
const incCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      if (!r.headersSent) r.status(status).json({ success: false, message: (err as Error)?.message });
    }
  },
  incCounter,
}));

// --- api-core mock ----------------------------------------------------------
const emitAudit = jest.fn();
type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendError: (res: Res, status: number, message: string, code?: string, details?: unknown) => res.status(status).json({ success: false, message, code, details }),
  sendEntityNotFound: (res: Res, entity: string) => res.status(404).json({ success: false, message: `${entity} not found` }),
  // Needed by the sibling route modules that createImageRoutes also mounts.
  getParam: (params: Record<string, string>, key: string) => params[key],
  parsePaginationParams: (q: Record<string, unknown>) => ({ limit: q.limit ? Number(q.limit) : 100 }),
  runConcurrent: async <T>(items: T[], _n: number, fn: (t: T) => Promise<void>) => {
    for (const item of items) await fn(item);
  },
  emitAudit,
}));

const express = (await import('express')).default;
const { createImageRoutes } = await import('../src/routes/images.js');

let server: Server;
let baseUrl: string;

const USERS: Record<string, Record<string, unknown> | undefined> = {
  // Implicit-all superadmin.
  super: { isSuperAdmin: true, sub: 'admin', email: 'admin@x' },
  // Org tenant 'acme' holding BOTH registry perms (passes the copy AND gate).
  acme: { isSuperAdmin: false, organizationId: 'acme', permissions: ['registry:read', 'registry:write'], sub: 'u-acme', email: 'u@acme' },
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
  app.use('/api/images', createImageRoutes());
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const MANIFEST_MT = 'application/vnd.oci.image.manifest.v1+json';
const INDEX_MT = 'application/vnd.oci.image.index.v1+json';

beforeEach(() => {
  headManifest.mockResolvedValue(null);
  mountBlob.mockResolvedValue(undefined);
  putManifest.mockResolvedValue(undefined);
  // Default: single-arch source manifest.
  getManifest.mockImplementation(async () => ({
    body: { config: { digest: 'sha256:cfg' }, layers: [{ digest: 'sha256:l1' }] },
    digest: 'sha256:src',
    mediaType: MANIFEST_MT,
  }));
});

const copy = async (who: string | undefined, body: unknown) => {
  const res = await fetch(`${baseUrl}/api/images/copy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': who } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('POST /api/images/copy — per-repo org scoping', () => {
  it('denies a tenant reading ANOTHER org\'s source repo (403), before any registry read', async () => {
    const { status, body } = await copy('acme', { source: 'org-beta/foo:1.0', target: 'org-acme/foo:1.0' });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
    expect(getManifest).not.toHaveBeenCalled();
  });

  it('denies a tenant writing ANOTHER org\'s target repo (403)', async () => {
    const { status, body } = await copy('acme', { source: 'org-acme/foo:1.0', target: 'org-beta/foo:1.0' });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
    expect(getManifest).not.toHaveBeenCalled();
  });

  it('allows a tenant to copy WITHIN its own org namespace', async () => {
    const { status, body } = await copy('acme', { source: 'org-acme/foo:1.0', target: 'org-acme/foo:2.0' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

describe('POST /api/images/copy — cross-tenant guard', () => {
  it('rejects a cross-tenant copy without allowCrossTenant (superadmin)', async () => {
    const { status, body } = await copy('super', { source: 'org-acme/foo:1.0', target: 'org-beta/foo:1.0' });
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect((body.details as { reason?: string })?.reason).toBe('cross-tenant-not-allowed');
  });

  it('allows a cross-tenant copy WITH allowCrossTenant (superadmin) + emits durable audit', async () => {
    const { status, body } = await copy('super', { source: 'org-acme/foo:1.0', target: 'org-beta/foo:1.0', allowCrossTenant: true });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(emitImageRegistryAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.image.copy',
      targetType: 'registry-image',
      details: expect.objectContaining({ crossTenant: true }),
    }));
  });
});

describe('POST /api/images/copy — happy paths', () => {
  it('copies a single-arch image (mounts config+layers, PUTs the manifest)', async () => {
    const { status, body } = await copy('super', { source: 'library/foo:1.0', target: 'library/bar:1.0' });
    expect(status).toBe(200);
    expect((body.data as { mounted?: { manifests: number; blobs: number } })?.mounted).toEqual({ manifests: 1, blobs: 2 });
    expect(mountBlob).toHaveBeenCalledWith('library/foo', 'library/bar', 'sha256:cfg');
    expect(mountBlob).toHaveBeenCalledWith('library/foo', 'library/bar', 'sha256:l1');
    expect(putManifest).toHaveBeenCalledWith('library/bar', '1.0', expect.anything(), MANIFEST_MT);
  });

  it('copies a multi-arch index (fetches each child, mounts unique blobs, PUTs children + index)', async () => {
    getManifest.mockImplementation(async (_name, ref) => {
      if (ref === '1.0') return { body: { manifests: [{ digest: 'sha256:c1' }, { digest: 'sha256:c2' }] }, digest: 'sha256:idx', mediaType: INDEX_MT };
      if (ref === 'sha256:c1') return { body: { config: { digest: 'sha256:cfg1' }, layers: [{ digest: 'sha256:shared' }] }, digest: ref, mediaType: MANIFEST_MT };
      if (ref === 'sha256:c2') return { body: { config: { digest: 'sha256:cfg2' }, layers: [{ digest: 'sha256:shared' }] }, digest: ref, mediaType: MANIFEST_MT };
      throw { statusCode: 404 };
    });

    const { status, body } = await copy('super', { source: 'library/foo:1.0', target: 'library/bar:1.0' });
    expect(status).toBe(200);
    // 1 index + 2 child manifests; unique blobs cfg1,cfg2,shared = 3 (deduped).
    expect((body.data as { mounted?: { manifests: number; blobs: number } })?.mounted).toEqual({ manifests: 3, blobs: 3 });
    // The index manifest lands at the target ref.
    expect(putManifest).toHaveBeenCalledWith('library/bar', '1.0', expect.anything(), INDEX_MT);
  });

  it('409s when the target tag exists with a different digest and overwrite is false', async () => {
    headManifest.mockResolvedValue({ digest: 'sha256:different' });
    const { status, body } = await copy('super', { source: 'library/foo:1.0', target: 'library/bar:1.0' });
    expect(status).toBe(409);
    expect(body.code).toBe('CONFLICT');
    expect(putManifest).not.toHaveBeenCalled();
  });
});
