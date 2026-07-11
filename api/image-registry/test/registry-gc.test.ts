// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for runRegistryGc — a data-loss path (it DELETEs manifests by digest).
 *
 * The three properties that matter for not nuking live images:
 *  - dry-run mode identifies candidates but issues ZERO deletes;
 *  - a real run deletes ONLY the stale (past-cutoff) tags;
 *  - a recent / retained tag is NEVER deleted.
 *
 * Mocked at the registry-client boundary so no real HTTP/registry is touched.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const listRepositoriesUnderPrefix = jest.fn<(p: string) => Promise<string[]>>();
const listTags = jest.fn<(name: string) => Promise<{ tags: string[] }>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ body: unknown; digest: string; mediaType: string }>>();
const getBlobJson = jest.fn<(name: string, digest: string) => Promise<unknown>>();
const deleteManifest = jest.fn<(name: string, digest: string) => Promise<void>>();
const isNotFound = (e: unknown): boolean => (e as { statusCode?: number })?.statusCode === 404;

jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositoriesUnderPrefix,
  listTags,
  getManifest,
  getBlobJson,
  deleteManifest,
  isNotFound,
  // Present on the module but unused by registry-gc.
  listRepositories: jest.fn(),
  putManifest: jest.fn(),
  headManifest: jest.fn(),
  headBlob: jest.fn(),
  getBlobStream: jest.fn(),
  mountBlob: jest.fn(),
}));

const invalidateStorageCache = jest.fn();
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({
  invalidateStorageCache,
  computeStorageUsage: jest.fn(),
}));

const incCounter = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ incCounter }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { runRegistryGc } = await import('../src/services/registry-gc.js');

// A well-past-cutoff timestamp (default maxAgeDays = 30) and a fresh one.
const STALE = '2020-01-01T00:00:00.000Z';
const RECENT = new Date().toISOString();

/** Wire a single repo `org-acme/app` whose tags carry the given `created` times. */
function wireRepo(tagsToCreated: Record<string, string>) {
  listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app']);
  listTags.mockResolvedValue({ tags: Object.keys(tagsToCreated) });
  getManifest.mockImplementation(async (_name, ref) => {
    const created = tagsToCreated[ref];
    if (!created) throw { statusCode: 404 };
    return { body: { created }, digest: `sha256:digest-${ref}`, mediaType: 'application/vnd.oci.image.manifest.v1+json' };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runRegistryGc', () => {
  it('dry-run identifies candidates but issues ZERO deletes', async () => {
    wireRepo({ old: STALE, keep: RECENT });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: true });

    expect(deleteManifest).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    // The stale tag is still counted as a candidate so the operator sees impact.
    expect(result.candidates).toBe(1);
    expect(result.reposScanned).toBe(1);
    // Dry-run must not touch the storage cache (nothing changed).
    expect(invalidateStorageCache).not.toHaveBeenCalled();
  });

  it('real run deletes ONLY the stale tag, leaving the recent tag untouched', async () => {
    wireRepo({ old: STALE, keep: RECENT });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    expect(deleteManifest).toHaveBeenCalledTimes(1);
    expect(deleteManifest).toHaveBeenCalledWith('org-acme/app', 'sha256:digest-old');
    // The retained tag's digest must never be passed to delete.
    expect(deleteManifest).not.toHaveBeenCalledWith('org-acme/app', 'sha256:digest-keep');
    expect(result.deleted).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.perRepo).toEqual([{ repo: 'org-acme/app', scanned: 2, deleted: 1 }]);
    // A real deletion invalidates the storage rollup cache.
    expect(invalidateStorageCache).toHaveBeenCalledWith('org-acme/');
  });

  it('does not delete anything when every tag is within the retention window', async () => {
    wireRepo({ keep1: RECENT, keep2: RECENT });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    expect(deleteManifest).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.candidates).toBe(0);
    // No deletes → no cache invalidation.
    expect(invalidateStorageCache).not.toHaveBeenCalled();
  });

  it('throws when prefix is missing (guards against full-registry GC)', async () => {
    await expect(runRegistryGc({ prefix: '' })).rejects.toThrow('prefix is required');
    expect(listRepositoriesUnderPrefix).not.toHaveBeenCalled();
  });
});
