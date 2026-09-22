// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the public-namespace parts of services/storage-usage (plugin
 * ecosystem G40): an org's `storageBytes` rollup counts its own `org-<id>/*`
 * namespace PLUS every `public/*` repository billed to it (so a publisher pays
 * for its listed versions even after deleting its private copy), shared blobs
 * counted once; an unreadable publication record makes the rollup incomplete
 * (the fail-closed push gate must not under-count); and the `public/` rollup
 * feeds the namespace footprint gauge.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

const listRepositoriesUnderPrefix = jest.fn<(p: string) => Promise<string[]>>();
const listTags = jest.fn<(name: string) => Promise<{ tags: string[] }>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ body: unknown; digest: string; mediaType: string }>>();
const headBlob = jest.fn<(name: string, digest: string) => Promise<{ contentLength?: number }>>();
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({
  listRepositoriesUnderPrefix, listTags, getManifest, headBlob,
}));

const publicRepositoriesOwnedBy = jest.fn<(orgId: string) => Promise<{ repositories: string[]; complete: boolean }>>();
jest.unstable_mockModule('../src/services/public-publications.js', () => ({ publicRepositoriesOwnedBy }));

const setGauge = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ setGauge }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const {
  computeOrgStorageUsage,
  computeStorageUsage,
  invalidateStorageCache,
  invalidateOrgStorageCache,
  PUBLIC_STORAGE_GAUGE,
} = await import('../src/services/storage-usage.js');

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const SIZES: Record<string, number> = { 'sha256:cfg-own': 10, 'sha256:shared': 1000, 'sha256:cfg-pub': 20, 'sha256:other': 5 };

/** org-acme/app → cfg-own + shared; public/acme/app → cfg-pub + shared (a MOUNT of the same layer). */
const REPO_BLOBS: Record<string, string[]> = {
  'org-acme/app': ['sha256:cfg-own', 'sha256:shared'],
  'public/acme/app': ['sha256:cfg-pub', 'sha256:shared'],
  'public/beta/tool': ['sha256:other'],
};

let org = 0;
/** A fresh org id per test, so the module-level rollup cache never leaks between tests. */
const nextOrg = () => `acme${++org}`;

beforeEach(() => {
  jest.clearAllMocks();
  listRepositoriesUnderPrefix.mockImplementation(async (prefix) =>
    (prefix.startsWith('org-') ? ['org-acme/app'] : Object.keys(REPO_BLOBS).filter((r) => r.startsWith(prefix))));
  listTags.mockResolvedValue({ tags: ['v1'] });
  getManifest.mockImplementation(async (repo) => {
    const [cfg, ...layers] = REPO_BLOBS[repo];
    return { body: { config: { digest: cfg }, layers: layers.map((digest) => ({ digest })) }, digest: `sha256:m-${repo}`, mediaType: MANIFEST };
  });
  headBlob.mockImplementation(async (_repo, digest) => ({ contentLength: SIZES[digest] }));
  publicRepositoriesOwnedBy.mockResolvedValue({ repositories: ['public/acme/app'], complete: true });
});

describe('computeOrgStorageUsage', () => {
  it('attributes the org\'s published public/* repositories to it, counting a shared (mounted) layer once', async () => {
    const id = nextOrg();
    const usage = await computeOrgStorageUsage(id);
    expect(publicRepositoriesOwnedBy).toHaveBeenCalledWith(id);
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledWith(`org-${id}/`);
    expect(getManifest).toHaveBeenCalledWith('public/acme/app', 'v1');
    // cfg-own 10 + shared 1000 (once) + cfg-pub 20.
    expect(usage).toMatchObject({ prefix: `org-${id}/`, bytes: 1030, blobs: 3, repos: 2, incomplete: false });
    // Another publisher's listing is not billed here.
    expect(getManifest).not.toHaveBeenCalledWith('public/beta/tool', expect.anything());
  });

  it('counts only the own namespace for an org that publishes nothing', async () => {
    publicRepositoriesOwnedBy.mockResolvedValue({ repositories: [], complete: true });
    const usage = await computeOrgStorageUsage(nextOrg());
    expect(usage).toMatchObject({ bytes: 1010, repos: 1, incomplete: false });
  });

  it('still bills a publisher whose private copy is gone', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue([]);
    const usage = await computeOrgStorageUsage(nextOrg());
    expect(usage).toMatchObject({ bytes: 1020, repos: 1, incomplete: false });
  });

  it('is incomplete (fail-closed) when a publication record could not be read', async () => {
    publicRepositoriesOwnedBy.mockResolvedValue({ repositories: ['public/acme/app'], complete: false });
    const id = nextOrg();
    expect((await computeOrgStorageUsage(id)).incomplete).toBe(true);
    // …and is not cached: the next call recomputes.
    await computeOrgStorageUsage(id);
    expect(publicRepositoriesOwnedBy).toHaveBeenCalledTimes(2);
  });

  it('is incomplete (fail-closed) when the publication records throw', async () => {
    publicRepositoriesOwnedBy.mockRejectedValue(new Error('registry-meta unreadable'));
    const usage = await computeOrgStorageUsage(nextOrg());
    expect(usage.incomplete).toBe(true);
    // The own namespace is still measured.
    expect(usage.bytes).toBe(1010);
  });

  it('is incomplete when a published repository cannot be scanned', async () => {
    getManifest.mockImplementation(async (repo) => {
      if (repo.startsWith('public/')) throw Object.assign(new Error('500'), { statusCode: 500 });
      return { body: { config: { digest: 'sha256:cfg-own' }, layers: [] }, digest: 'sha256:m', mediaType: MANIFEST };
    });
    expect((await computeOrgStorageUsage(nextOrg())).incomplete).toBe(true);
  });

  it('caches a complete rollup; force recomputes', async () => {
    const id = nextOrg();
    await computeOrgStorageUsage(id);
    const cached = await computeOrgStorageUsage(id);
    expect(cached).toMatchObject({ bytes: 1030, incomplete: false });
    expect(publicRepositoriesOwnedBy).toHaveBeenCalledTimes(1);
    await computeOrgStorageUsage(id, { force: true });
    expect(publicRepositoriesOwnedBy).toHaveBeenCalledTimes(2);
  });

  it('invalidateOrgStorageCache evicts the combined rollup', async () => {
    const id = nextOrg();
    await computeOrgStorageUsage(id);
    invalidateOrgStorageCache(id);
    await computeOrgStorageUsage(id);
    expect(publicRepositoriesOwnedBy).toHaveBeenCalledTimes(2);
  });

  it('invalidating the org namespace prefix also evicts the combined rollup', async () => {
    const id = nextOrg();
    await computeOrgStorageUsage(id);
    invalidateStorageCache(`org-${id}/`);
    await computeOrgStorageUsage(id);
    expect(publicRepositoriesOwnedBy).toHaveBeenCalledTimes(2);
  });

  it('invalidating an unrelated prefix leaves the combined rollup cached', async () => {
    const id = nextOrg();
    await computeOrgStorageUsage(id);
    invalidateStorageCache('public/');
    invalidateStorageCache('org-someoneelse/');
    await computeOrgStorageUsage(id);
    expect(publicRepositoriesOwnedBy).toHaveBeenCalledTimes(1);
  });
});

describe('computeStorageUsage(\'public/\') — namespace footprint gauge', () => {
  it('sets the public storage gauge from a complete rollup', async () => {
    const usage = await computeStorageUsage('public/', { force: true });
    expect(usage).toMatchObject({ bytes: 1025, repos: 2, incomplete: false });
    expect(setGauge).toHaveBeenCalledWith(PUBLIC_STORAGE_GAUGE, {}, 1025);
    expect(PUBLIC_STORAGE_GAUGE).toBe('registry_public_storage_bytes');
  });

  it('does not publish an under-counted (incomplete) total', async () => {
    headBlob.mockRejectedValue(Object.assign(new Error('500'), { statusCode: 500 }));
    const usage = await computeStorageUsage('public/', { force: true });
    expect(usage.incomplete).toBe(true);
    expect(setGauge).not.toHaveBeenCalled();
  });

  it('never sets the public gauge for an org rollup', async () => {
    await computeStorageUsage('org-acme/', { force: true });
    expect(setGauge).not.toHaveBeenCalled();
  });

  it('serves a cached complete rollup without rescanning', async () => {
    await computeStorageUsage('public/', { force: true });
    listTags.mockClear();
    const cached = await computeStorageUsage('public/');
    expect(cached).toMatchObject({ bytes: 1025, incomplete: false });
    expect(listTags).not.toHaveBeenCalled();
  });
});

// Anonymous plugin submissions (plugin ecosystem §4.2 / W5) are billed to nobody.
describe('quarantine/* storage', () => {
  beforeEach(() => { REPO_BLOBS['quarantine/sub-1'] = ['sha256:other']; });

  it('is excluded from any rollup whose prefix is not the quarantine namespace itself', async () => {
    listRepositoriesUnderPrefix.mockImplementation(async () => ['org-acme/app', 'quarantine/sub-1']);
    await computeStorageUsage('', { force: true });
    const scanned = new Set(listTags.mock.calls.map((c) => c[0]));
    expect(scanned.has('quarantine/sub-1')).toBe(false);
    expect(scanned.has('org-acme/app')).toBe(true);
  });

  it('is counted when the quarantine namespace is asked for (the quarantine GC gauge)', async () => {
    listRepositoriesUnderPrefix.mockImplementation(async () => ['quarantine/sub-1']);
    const usage = await computeStorageUsage('quarantine/', { force: true });
    expect(usage.repos).toBe(1);
  });

  it('never enters an org rollup', async () => {
    publicRepositoriesOwnedBy.mockResolvedValue({ repositories: [], complete: true });
    await computeOrgStorageUsage(nextOrg(), { force: true });
    expect(listRepositoriesUnderPrefix.mock.calls.every((c) => c[0].startsWith('org-'))).toBe(true);
    expect(listTags.mock.calls.some((c) => c[0].startsWith('quarantine/'))).toBe(false);
  });
});
