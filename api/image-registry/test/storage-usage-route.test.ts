// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route tests for `GET /internal/storage-usage/:orgId` — quota → one org's
 * measured registry storage, which fills `storageBytes.used` on the quota
 * service's dashboard reads (api/quota `fetchOrgStorageBytes`).
 *
 * The router runs on a real Express app over HTTP behind the REAL api-core
 * `requireInternalService` gate, so the caller allow-list, the org binding and
 * the `{ data: { bytes } }` contract the quota client parses are all exercised
 * as shipped. Only the measurement (`computeOrgStorageUsage`, its own suite) is
 * stubbed.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest, beforeAll, afterAll, beforeEach, describe, it, expect } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

const deleteTag = jest.fn<(repo: string, tag: string) => Promise<void>>();
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({ deleteTag }));
// The internal router's other routes have their own suites; keep their heavy
// dependencies out of this one.
jest.unstable_mockModule('../src/routes/internal-publications.js', () => ({
  registerPublicationRoutes: () => undefined,
  PLUGIN_PUBLICATIONS_PATH: '/plugin-publications',
}));
jest.unstable_mockModule('../src/services/plugin-signing.js', () => ({
  signPluginImage: jest.fn<AnyFn>(),
  PluginSigningError: class extends Error {},
}));
const deleteOrgNamespace = jest.fn<(orgId: string) => Promise<{ repositories: number; deleted: number; failed: string[] }>>();
jest.unstable_mockModule('../src/services/registry-gc.js', () => ({
  deleteQuarantineRepository: jest.fn<AnyFn>(),
  deleteOrgNamespace,
}));
jest.unstable_mockModule('../src/services/quarantine-credential.js', () => ({
  mintQuarantineCredential: jest.fn<AnyFn>(),
  isQuarantineSubmissionId: () => true,
}));

const computeOrgStorageUsage = jest.fn<(orgId: string) => Promise<{ prefix: string; bytes: number; repos: number; blobs: number; computedAt: number; incomplete: boolean }>>();
const computeOrgStorageBreakdown = jest.fn<AnyFn>();
const invalidateOrgStorageCache = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({
  computeOrgStorageUsage,
  // `routes/internal.ts` imports all three; a module mock missing any of them
  // fails every suite in this file at LOAD rather than at the assertion.
  computeOrgStorageBreakdown,
  invalidateOrgStorageCache,
}));

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
}));

const recordAuthzDenialMock = jest.fn<AnyFn>();
type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAuthzDenial: recordAuthzDenialMock,
  sendSuccess: (res: Res, status: number, data: unknown) => res.status(status).json({ success: true, data }),
  sendBadRequest: (res: Res, message: string, code?: string) => res.status(400).json({ success: false, message, code }),
  sendError: (res: Res, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  audited: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  // requireInternalService is NOT overridden: the real api-core gate runs.
}));

const express = (await import('express')).default;
const { createInternalRoutes, STORAGE_USAGE_PATH } = await import('../src/routes/internal.js');

const ORG = '6650f0c3a1b2c3d4e5f60718';
const OTHER_ORG = 'deadbeefdeadbeefdeadbeef';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  // Stand-in for requireAuth. Default: the quota SERVICE principal minted for
  // ORG (as api/quota's client does); headers let a test become another service,
  // a user, anonymous, or a token for another org.
  app.use((req, _res, next) => {
    const as = req.header('x-test-as') ?? 'service:quota';
    if (as !== 'anonymous') {
      const isService = as.startsWith('service:');
      (req as { user?: unknown }).user = {
        principalType: isService ? 'service' : 'user',
        sub: isService ? as : 'user-1',
        ...(isService && { serviceName: as.slice('service:'.length) }),
        isSuperAdmin: req.header('x-test-superadmin') === 'true',
        organizationId: req.header('x-test-org') ?? ORG,
      };
    }
    next();
  });
  app.use('/internal', createInternalRoutes());
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  computeOrgStorageUsage.mockResolvedValue({ prefix: `org-${ORG}/`, bytes: 1_234_567, repos: 3, blobs: 9, computedAt: 0, incomplete: false });
});

const get = async (orgId: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${baseUrl}/internal/storage-usage/${encodeURIComponent(orgId)}`, { headers });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('GET /internal/storage-usage/:orgId', () => {
  it('is mounted at the exact path the quota client calls', () => {
    // api/quota REGISTRY_STORAGE_USAGE_PATH = '/internal/storage-usage'.
    expect(`/internal${STORAGE_USAGE_PATH}`).toBe('/internal/storage-usage');
  });

  it('answers the quota service with { data: { bytes } } and nothing else', async () => {
    const { status, body } = await get(ORG);
    expect(status).toBe(200);
    expect(body.data).toEqual({ bytes: 1_234_567 });
    expect(computeOrgStorageUsage).toHaveBeenCalledWith(ORG);
  });

  it('still answers with what it measured when the scan was incomplete (display-only consumer)', async () => {
    computeOrgStorageUsage.mockResolvedValue({ prefix: `org-${ORG}/`, bytes: 42, repos: 1, blobs: 1, computedAt: 0, incomplete: true });
    const { status, body } = await get(ORG);
    expect(status).toBe(200);
    expect(body.data).toEqual({ bytes: 42 });
  });

  it.each([
    ['another service', { 'x-test-as': 'service:plugin' }, 403],
    ['a user token, even a superadmin', { 'x-test-as': 'user', 'x-test-superadmin': 'true' }, 403],
    ['an unauthenticated request', { 'x-test-as': 'anonymous' }, 401],
  ])('refuses %s without measuring', async (_label, headers, expected) => {
    const { status } = await get(ORG, headers);
    expect(status).toBe(expected);
    expect(computeOrgStorageUsage).not.toHaveBeenCalled();
  });

  it('refuses a quota token minted for a different org (403 ORG_MISMATCH, on the authz.denied trail)', async () => {
    const { status, body } = await get(ORG, { 'x-test-org': OTHER_ORG });
    expect(status).toBe(403);
    expect(body.code).toBe('ORG_MISMATCH');
    expect(recordAuthzDenialMock).toHaveBeenCalled();
    expect(computeOrgStorageUsage).not.toHaveBeenCalled();
  });

  it('rejects an org id that is not one registry path component (400)', async () => {
    const { status } = await get('acme/../other', { 'x-test-org': 'acme/../other' });
    expect(status).toBe(400);
    expect(computeOrgStorageUsage).not.toHaveBeenCalled();
  });

  it('answers 500 when the measurement fails, which the quota client reads as unknown', async () => {
    computeOrgStorageUsage.mockRejectedValue(new Error('registry unreachable'));
    const { status } = await get(ORG);
    expect(status).toBe(500);
  });
});


// ── The storage reclaim + teardown routes ─────────────────────────────────────

const asPlugin = { 'x-test-as': 'service:plugin' };
const asPlatform = { 'x-test-as': 'service:platform' };

const getJson = async (path: string, headers: Record<string, string>) => {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const sendJson = async (method: 'DELETE', path: string, headers: Record<string, string>, body?: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('GET /internal/storage-breakdown/:orgId', () => {
  beforeEach(() => {
    computeOrgStorageBreakdown.mockResolvedValue({
      orgId: ORG,
      bytes: 100,
      entries: [{ repo: `org-${ORG}/app`, tag: '1.0.0', totalBytes: 100, marginalBytes: 10, published: false }],
      computedAt: 0,
      incomplete: false,
    });
  });

  it('answers the plugin service with the whole breakdown, `incomplete` included', async () => {
    // `incomplete` is carried rather than swallowed: a tenant reading this is
    // about to decide what to delete, so an under-stated list must say so.
    const { status, body } = await getJson(`/internal/storage-breakdown/${ORG}`, asPlugin);
    expect(status).toBe(200);
    expect(body.data).toEqual(expect.objectContaining({ bytes: 100, incomplete: false }));
  });

  it('refuses a caller that is not the plugin service', async () => {
    const { status } = await getJson(`/internal/storage-breakdown/${ORG}`, { 'x-test-as': 'service:quota' });
    expect(status).toBe(403);
  });

  it('refuses a token for a DIFFERENT org', async () => {
    // A per-version footprint is as confidential as the total.
    const { status } = await getJson(`/internal/storage-breakdown/${ORG}`, { ...asPlugin, 'x-test-org': OTHER_ORG });
    expect(status).toBe(403);
    expect(recordAuthzDenialMock).toHaveBeenCalled();
  });
});

describe('DELETE /internal/storage-prune/:orgId', () => {
  it('drops the version TAG and evicts the cached reading', async () => {
    // A tag delete is enough: storage is measured by walking tags → manifests →
    // blobs, so the layers leave the org's total at once. It is also the
    // conservative choice — a digest-pinned pipeline keeps working.
    const { status, body } = await sendJson('DELETE', `/internal/storage-prune/${ORG}`, asPlugin, { repo: `org-${ORG}/app`, tag: '1.0.0' });
    expect(status).toBe(200);
    expect(body.data).toEqual({ repo: `org-${ORG}/app`, tag: '1.0.0', pruned: true });
    expect(deleteTag).toHaveBeenCalledWith(`org-${ORG}/app`, '1.0.0');
    expect(invalidateOrgStorageCache).toHaveBeenCalledWith(ORG);
  });

  it('refuses a repo outside the caller\'s own namespace, published copies included', async () => {
    // `public/*` is excluded deliberately: a published copy's bytes stay billed
    // to the publisher until the listing is withdrawn, so deleting it here
    // would free nothing AND break the orgs that installed it.
    for (const repo of ['public/acme/app', 'system/base', `org-${OTHER_ORG}/app`]) {
      const { status } = await sendJson('DELETE', `/internal/storage-prune/${ORG}`, asPlugin, { repo, tag: '1.0.0' });
      expect({ repo, status }).toEqual({ repo, status: 403 });
    }
    expect(deleteTag).not.toHaveBeenCalled();
  });

  it('refuses a digest where a tag is required', async () => {
    // Deleting by digest would take any second tag on the same manifest with it.
    const { status } = await sendJson('DELETE', `/internal/storage-prune/${ORG}`, asPlugin, {
      repo: `org-${ORG}/app`, tag: 'sha256:abc',
    });
    expect(status).toBe(400);
  });

  it('refuses a caller that is not the plugin service', async () => {
    const { status } = await sendJson('DELETE', `/internal/storage-prune/${ORG}`, { 'x-test-as': 'service:quota' }, { repo: `org-${ORG}/app`, tag: '1.0.0' });
    expect(status).toBe(403);
  });
});

describe('DELETE /internal/org-namespace/:orgId', () => {
  beforeEach(() => {
    deleteOrgNamespace.mockResolvedValue({ repositories: 2, deleted: 5, failed: [] });
  });

  it('purges a deleted org\'s private namespace for the platform cascade', async () => {
    const { status, body } = await sendJson('DELETE', `/internal/org-namespace/${ORG}`, asPlatform);
    expect(status).toBe(200);
    expect(body.data).toEqual({ repositories: 2, deleted: 5, failed: [] });
    expect(deleteOrgNamespace).toHaveBeenCalledWith(ORG.toLowerCase());
  });

  it('does NOT require the token to match the org — by then the org is gone', async () => {
    // The other two routes confine a token to its own org. Here the org has
    // already been deleted, so there is no org token to check: the caller list
    // and the mesh policy are the authorization.
    const { status } = await sendJson('DELETE', `/internal/org-namespace/${ORG}`, { ...asPlatform, 'x-test-org': OTHER_ORG });
    expect(status).toBe(200);
  });

  it('reports a partial purge rather than a clean teardown', async () => {
    deleteOrgNamespace.mockResolvedValue({ repositories: 1, deleted: 1, failed: [`org-${ORG}/stuck`] });
    const { status, body } = await sendJson('DELETE', `/internal/org-namespace/${ORG}`, asPlatform);
    expect(status).toBe(200);
    expect((body.data as { failed: string[] }).failed).toEqual([`org-${ORG}/stuck`]);
  });

  it('refuses every caller but the platform service', async () => {
    for (const as of ['service:plugin', 'service:quota']) {
      const { status } = await sendJson('DELETE', `/internal/org-namespace/${ORG}`, { 'x-test-as': as });
      expect({ as, status }).toEqual({ as, status: 403 });
    }
    expect(deleteOrgNamespace).not.toHaveBeenCalled();
  });
});
