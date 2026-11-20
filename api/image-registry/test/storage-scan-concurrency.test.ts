// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * scanRepositories with bounded concurrency (REGISTRY_STORAGE_SCAN_CONCURRENCY):
 * the tag-list, manifest and blob-HEAD loops keep up to N registry calls in
 * flight, and the answer — totals, blob count, incompleteness, the per-blob
 * breakdown and its order — is identical to a serial scan's.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

const listRepositoriesUnderPrefix = jest.fn<(p: string) => Promise<string[]>>();
const listTags = jest.fn<(name: string) => Promise<{ tags: string[] }>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ body: unknown; digest: string; mediaType: string }>>();
const headBlob = jest.fn<(name: string, digest: string) => Promise<{ contentLength?: number }>>();
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({
  listRepositoriesUnderPrefix, listTags, getManifest, headBlob,
}));
jest.unstable_mockModule('../src/services/public-publications.js', () => ({
  publicRepositoriesOwnedBy: jest.fn(async () => ({ repositories: [], complete: true })),
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { scanRepositories, storageScanConcurrency, newScanTimings } = await import('../src/services/storage-usage.js');
const { createLimiter } = await import('../src/services/concurrency.js');

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const INDEX = 'application/vnd.oci.image.index.v1+json';
const ENV = 'REGISTRY_STORAGE_SCAN_CONCURRENCY';
const notFound = () => Object.assign(new Error('404'), { statusCode: 404 });

/**
 * 6 repos × 3 tags. Every image shares `base`; `multi` tags are multi-arch
 * indexes whose children add per-arch layers; `lonely` lives only in repo-5,
 * so its HEAD 404s against every other repo — exercising the per-blob fallback.
 */
const REPOS = Array.from({ length: 6 }, (_, i) => `org-acme/repo-${i}`);
const TAGS = ['v1', 'v2', 'multi'];
const size = (digest: string): number => digest.length * 7;

let inFlight = 0;
let peak = 0;
const call = async <T>(ms: number, fn: () => T): Promise<T> => {
  inFlight++;
  peak = Math.max(peak, inFlight);
  try {
    // Uneven latencies so completion order differs from start order.
    await new Promise((r) => setTimeout(r, ms));
    return fn();
  } finally {
    inFlight--;
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  inFlight = 0;
  peak = 0;
  listTags.mockImplementation((repo) => call(3 + (repo.length % 4), () => ({ tags: TAGS })));
  getManifest.mockImplementation((repo, ref) => call(1 + (ref.length % 5), () => {
    const r = repo.slice(-1);
    if (ref === 'multi') {
      return { body: { manifests: [{ digest: `sha256:amd-${r}` }, { digest: `sha256:arm-${r}` }] }, digest: `sha256:idx-${r}`, mediaType: INDEX };
    }
    if (ref.startsWith('sha256:')) {
      return { body: { config: { digest: `${ref}-cfg` }, layers: [{ digest: 'sha256:base' }, { digest: `${ref}-layer` }] }, digest: ref, mediaType: MANIFEST };
    }
    const layers = [{ digest: 'sha256:base' }, { digest: `sha256:${ref}-${r}` }];
    if (r === '5') layers.push({ digest: 'sha256:lonely' });
    return { body: { config: { digest: `sha256:cfg-${ref}-${r}` }, layers }, digest: `sha256:m-${ref}-${r}`, mediaType: MANIFEST };
  }));
  headBlob.mockImplementation((repo, digest) => call(1 + (digest.length % 3), () => {
    if (digest === 'sha256:lonely' && repo !== 'org-acme/repo-5') throw notFound();
    return { contentLength: size(digest) };
  }));
});

afterEach(() => { delete process.env[ENV]; });

async function scanAt(concurrency: number) {
  process.env[ENV] = String(concurrency);
  peak = 0;
  return scanRepositories(REPOS, { detail: true });
}

describe('scanRepositories with REGISTRY_STORAGE_SCAN_CONCURRENCY', () => {
  it('keeps up to N registry calls in flight (serial when 1)', async () => {
    await scanAt(1);
    expect(peak).toBe(1);
    await scanAt(4);
    expect(peak).toBe(4);
  });

  it('produces the same totals, blob count and per-blob breakdown (in the same order) as a serial scan', async () => {
    const serial = await scanAt(1);
    const parallel = await scanAt(8);
    expect(serial.incomplete).toBe(false);
    expect(parallel.bytes).toBe(serial.bytes);
    expect(parallel.blobs).toBe(serial.blobs);
    expect(parallel.incomplete).toBe(serial.incomplete);
    expect([...parallel.perBlob!.entries()]).toEqual([...serial.perBlob!.entries()]);
    // The fixture really exercises dedup and the 404 fallback.
    expect(serial.perBlob!.get('sha256:base')!.refs.length).toBe(REPOS.length * TAGS.length);
    expect(serial.perBlob!.get('sha256:lonely')!.size).toBe(size('sha256:lonely'));
  });

  it('a failure is reported the same way: incomplete, everything else still counted', async () => {
    getManifest.mockImplementation(async (repo, ref) => {
      if (repo === 'org-acme/repo-2' && ref === 'v2') throw Object.assign(new Error('500'), { statusCode: 500 });
      return { body: { config: { digest: `sha256:c-${repo}-${ref}` }, layers: [] }, digest: 'sha256:m', mediaType: MANIFEST };
    });
    const serial = await scanAt(1);
    const parallel = await scanAt(8);
    expect(serial).toMatchObject({ incomplete: true, blobs: REPOS.length * TAGS.length - 1 });
    expect(parallel).toEqual(serial);
  });

  it('still accumulates per-phase timings', async () => {
    process.env[ENV] = '4';
    const timings = newScanTimings();
    await scanRepositories(REPOS, { timings });
    expect(timings.tagsMs).toBeGreaterThan(0);
    expect(timings.manifestsMs).toBeGreaterThan(0);
    expect(timings.blobHeadsMs).toBeGreaterThan(0);
  });

  it('routes every registry call through a shared limiter when one is passed', async () => {
    process.env[ENV] = '8';
    const limiter = createLimiter(3);
    await Promise.all([scanRepositories(REPOS, { limiter }), scanRepositories(REPOS, { limiter })]);
    expect(peak).toBe(3);
  });
});

describe('storageScanConcurrency', () => {
  it('defaults to 8 and clamps to 1–64', () => {
    expect(storageScanConcurrency()).toBe(8);
    process.env[ENV] = '0';
    expect(storageScanConcurrency()).toBe(1);
    process.env[ENV] = '500';
    expect(storageScanConcurrency()).toBe(64);
    process.env[ENV] = '16';
    expect(storageScanConcurrency()).toBe(16);
  });
});
