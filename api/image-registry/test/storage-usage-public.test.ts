// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the public-namespace parts of services/storage-usage (plugin
 * ecosystem): the `public/` rollup feeds the namespace footprint gauge, and
 * `quarantine/*` is billed to nobody. An ORG's rollup scope (own namespace plus
 * the `public/*` repositories billed to it) is measured by the background
 * snapshot — see storage-snapshot.test.ts.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
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
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { setGauge }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const {
  computeStorageUsage,
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

// Anonymous plugin submissions are billed to nobody.
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
});
