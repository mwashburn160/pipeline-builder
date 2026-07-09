// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for computeStorageUsage — specifically the multi-arch recursion.
 * A multi-arch index must count each child manifest's config+layer blobs, not
 * just the index JSON; otherwise a multi-arch image's layer bytes go uncounted
 * and the storage push-gate (isStorageOverBudget) is bypassable.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const listRepositoriesUnderPrefix = jest.fn<(p: string) => Promise<string[]>>();
const listTags = jest.fn<(name: string) => Promise<{ tags: string[] }>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ body: unknown; digest: string; mediaType: string }>>();
const headBlob = jest.fn<(name: string, digest: string) => Promise<{ contentLength?: number }>>();
const isNotFound = (e: unknown): boolean => (e as { statusCode?: number })?.statusCode === 404;

jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositoriesUnderPrefix,
  listTags,
  getManifest,
  headBlob,
  isNotFound,
  // Unused by storage-usage but present on the module.
  listRepositories: jest.fn(),
  deleteManifest: jest.fn(),
  putManifest: jest.fn(),
  headManifest: jest.fn(),
  getBlobStream: jest.fn(),
  mountBlob: jest.fn(),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { computeStorageUsage } = await import('../src/services/storage-usage.js');

const INDEX = 'application/vnd.oci.image.index.v1+json';
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

describe('computeStorageUsage — multi-arch recursion', () => {
  beforeEach(() => jest.clearAllMocks());

  it('counts each child manifest\'s config+layer blobs, not just the index JSON', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['org/app']);
    listTags.mockResolvedValue({ tags: ['multi'] });
    getManifest.mockImplementation(async (_name, ref) => {
      if (ref === 'multi') {
        return { body: { manifests: [{ digest: 'sha256:child1' }, { digest: 'sha256:child2' }] }, digest: 'sha256:index', mediaType: INDEX };
      }
      if (ref === 'sha256:child1') {
        return { body: { config: { digest: 'sha256:cfg1' }, layers: [{ digest: 'sha256:layerShared' }] }, digest: ref, mediaType: MANIFEST };
      }
      if (ref === 'sha256:child2') {
        // Shares layerShared with child1 → must be de-duped, not double-counted.
        return { body: { config: { digest: 'sha256:cfg2' }, layers: [{ digest: 'sha256:layerShared' }] }, digest: ref, mediaType: MANIFEST };
      }
      throw { statusCode: 404 };
    });
    headBlob.mockResolvedValue({ contentLength: 100 });

    const usage = await computeStorageUsage('org', { force: true });

    // Unique blobs: child1, child2 (index JSON blobs) + cfg1, cfg2, layerShared = 5.
    // Pre-fix this was only 2 (the child manifest digests) → 200 bytes, a bypass.
    expect(usage.blobs).toBe(5);
    expect(usage.bytes).toBe(500);
    expect(usage.incomplete).toBe(false);
    // The recursion actually fetched each child manifest.
    expect(getManifest).toHaveBeenCalledWith('org/app', 'sha256:child1');
    expect(getManifest).toHaveBeenCalledWith('org/app', 'sha256:child2');
  });

  it('marks the rollup incomplete (fail-closed) when a child manifest fetch errors non-404', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['org/app']);
    listTags.mockResolvedValue({ tags: ['multi'] });
    getManifest.mockImplementation(async (_name, ref) => {
      if (ref === 'multi') return { body: { manifests: [{ digest: 'sha256:child1' }] }, digest: 'sha256:index', mediaType: INDEX };
      throw { statusCode: 500 }; // child fetch fails hard
    });
    headBlob.mockResolvedValue({ contentLength: 100 });

    const usage = await computeStorageUsage('org', { force: true });
    expect(usage.incomplete).toBe(true); // so the push-gate fails closed
  });
});
