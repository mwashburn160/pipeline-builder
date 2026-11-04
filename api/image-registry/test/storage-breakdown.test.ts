// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `computeOrgStorageBreakdown` — per-version attribution, and specifically the
 * MARGINAL byte figure.
 *
 * This is the one computation a prune surface cannot do without. Under
 * deduplication, deleting one of several versions sharing a base layer frees
 * only that version's own layers: the naive per-version size would promise
 * 500 MB and free 5. A surface showing the naive figure promises space it
 * cannot free, which is a worse failure than showing nothing — so these tests
 * pin the difference between `totalBytes` (what it occupies, shared included)
 * and `marginalBytes` (what deleting it actually returns).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

const listRepositoriesUnderPrefix = jest.fn<(p: string) => Promise<string[]>>();
const listTags = jest.fn<(name: string) => Promise<{ tags: string[] }>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ body: unknown; digest: string; mediaType: string }>>();
const headBlob = jest.fn<(name: string, digest: string) => Promise<{ contentLength?: number }>>();
const publicRepositoriesOwnedBy = jest.fn<(orgId: string) => Promise<{ repositories: string[]; complete: boolean }>>();

jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({
  listRepositoriesUnderPrefix,
  listTags,
  getManifest,
  headBlob,
}));
jest.unstable_mockModule('../src/services/public-publications.js', () => ({ publicRepositoriesOwnedBy }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { computeOrgStorageBreakdown, invalidateOrgStorageCache } = await import('../src/services/storage-usage.js');

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const MB = 1024 * 1024;

/** A manifest referencing `config` plus each layer digest. */
const manifest = (config: string, layers: string[]) => ({
  body: {
    mediaType: MANIFEST,
    config: { digest: config, size: 0 },
    layers: layers.map((digest) => ({ digest, size: 0 })),
  },
  digest: 'sha256:m',
  mediaType: MANIFEST,
});

/** Wire up one repo with `tag -> [config, ...layers]` and `digest -> bytes`. */
function registry(repos: Record<string, Record<string, string[]>>, sizes: Record<string, number>) {
  listRepositoriesUnderPrefix.mockResolvedValue(Object.keys(repos).filter((r) => r.startsWith('org-')));
  listTags.mockImplementation(async (name) => ({ tags: Object.keys(repos[name] ?? {}) }));
  getManifest.mockImplementation(async (name, ref) => {
    const blobs = repos[name]?.[ref];
    if (!blobs) throw Object.assign(new Error('not found'), { status: 404 });
    return manifest(blobs[0]!, blobs.slice(1));
  });
  headBlob.mockImplementation(async (_name, digest) => ({ contentLength: sizes[digest] ?? 0 }));
}

beforeEach(() => {
  jest.clearAllMocks();
  publicRepositoriesOwnedBy.mockResolvedValue({ repositories: [], complete: true });
  invalidateOrgStorageCache('acme');
});

describe('computeOrgStorageBreakdown — marginal bytes', () => {
  it('attributes a SHARED base layer to no version\'s marginal figure', async () => {
    // Two versions over one 400 MB base. Deleting either frees only its own
    // 10 MB layer — the base stays, because the other version still needs it.
    registry(
      { 'org-acme/app': { v1: ['sha256:cfg1', 'sha256:base', 'sha256:l1'], v2: ['sha256:cfg2', 'sha256:base', 'sha256:l2'] } },
      { 'sha256:cfg1': 1 * MB, 'sha256:cfg2': 1 * MB, 'sha256:base': 400 * MB, 'sha256:l1': 10 * MB, 'sha256:l2': 20 * MB },
    );
    const b = await computeOrgStorageBreakdown('acme');

    // The org's total counts the base ONCE — the dedup the tenant benefits from.
    expect(b.bytes).toBe((1 + 1 + 400 + 10 + 20) * MB);
    expect(b.incomplete).toBe(false);

    const v1 = b.entries.find((e) => e.tag === 'v1')!;
    const v2 = b.entries.find((e) => e.tag === 'v2')!;
    // What it OCCUPIES includes the shared base...
    expect(v1.totalBytes).toBe((1 + 400 + 10) * MB);
    // ...but what deleting it FREES does not.
    expect(v1.marginalBytes).toBe((1 + 10) * MB);
    expect(v2.marginalBytes).toBe((1 + 20) * MB);
    // The naive figure would have promised 411 MB and freed 11.
    expect(v1.totalBytes).toBeGreaterThan(v1.marginalBytes);
  });

  it('frees the whole image when nothing else references it', async () => {
    registry(
      { 'org-acme/solo': { v1: ['sha256:cfg', 'sha256:only'] } },
      { 'sha256:cfg': 2 * MB, 'sha256:only': 98 * MB },
    );
    const b = await computeOrgStorageBreakdown('acme');
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toEqual(expect.objectContaining({
      repo: 'org-acme/solo', tag: 'v1', totalBytes: 100 * MB, marginalBytes: 100 * MB, published: false,
    }));
  });

  it('counts a layer shared with the PUBLISHED copy as unprunable', async () => {
    // The public copy mounts the same blobs, so the private version's layers
    // are no longer unique — deleting it privately frees nothing, which is
    // exactly the trap the plan calls out. The published entry is labelled so a
    // surface can point at unlisting instead of offering a prune.
    publicRepositoriesOwnedBy.mockResolvedValue({ repositories: ['public/acme/app'], complete: true });
    registry(
      {
        'org-acme/app': { v1: ['sha256:cfg', 'sha256:l1'] },
        'public/acme/app': { v1: ['sha256:cfg', 'sha256:l1'] },
      },
      { 'sha256:cfg': 1 * MB, 'sha256:l1': 50 * MB },
    );
    const b = await computeOrgStorageBreakdown('acme');
    expect(b.bytes).toBe(51 * MB);
    const priv = b.entries.find((e) => e.repo === 'org-acme/app')!;
    const pub = b.entries.find((e) => e.repo === 'public/acme/app')!;
    expect(priv.marginalBytes).toBe(0);
    expect(pub.marginalBytes).toBe(0);
    expect(pub.published).toBe(true);
    expect(priv.published).toBe(false);
  });

  it('orders by what a prune would actually recover', async () => {
    // The biggest IMAGE is not the best thing to delete; the most reclaimable
    // is. `small` wins despite `big` occupying more.
    registry(
      {
        'org-acme/big': { a: ['sha256:c1', 'sha256:shared'], b: ['sha256:c2', 'sha256:shared'] },
        'org-acme/small': { x: ['sha256:c3', 'sha256:own'] },
      },
      { 'sha256:c1': 1, 'sha256:c2': 1, 'sha256:c3': 1, 'sha256:shared': 900 * MB, 'sha256:own': 50 * MB },
    );
    const b = await computeOrgStorageBreakdown('acme');
    expect(b.entries[0]).toEqual(expect.objectContaining({ repo: 'org-acme/small', tag: 'x' }));
    expect(b.entries[0]!.marginalBytes).toBe(50 * MB + 1);
  });

  it('marks the breakdown incomplete when a blob cannot be measured, and does not cache it', async () => {
    // An under-stated breakdown must say so: presenting it as the whole picture
    // would under-promise a prune and misattribute the missing bytes.
    registry(
      { 'org-acme/app': { v1: ['sha256:cfg', 'sha256:bad'] } },
      { 'sha256:cfg': 1 * MB },
    );
    headBlob.mockImplementation(async (_n, digest) => {
      if (digest === 'sha256:bad') throw Object.assign(new Error('registry down'), { status: 500 });
      return { contentLength: 1 * MB };
    });
    const first = await computeOrgStorageBreakdown('acme');
    expect(first.incomplete).toBe(true);
    // Not cached: a stale under-count must not outlive the outage that caused it.
    await computeOrgStorageBreakdown('acme');
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(2);
  });
});
