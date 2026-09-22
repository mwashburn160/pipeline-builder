// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for routes/public-directory — the anonymous directory API
 * (plugin-ecosystem §6a). The queries themselves (pipeline-data) and cosign
 * (supply-chain) are stubbed; these pin the HTTP contract: off → 404, strict
 * query validation, malformed paths → 404 (not 400), cache headers, the
 * zero-result log, and how SBOM failures map to status codes.
 */

import type { AddressInfo } from 'node:net';
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import express from 'express';

const mockSearch = jest.fn<(p: Record<string, unknown>) => Promise<unknown>>();
const mockCategories = jest.fn<() => Promise<unknown>>();
const mockSitemap = jest.fn<() => Promise<unknown>>();
const mockListing = jest.fn<(h: string, n: string) => Promise<unknown>>();
const mockListedVersion = jest.fn<(h: string, n: string, v: string) => Promise<unknown>>();
const mockReviews = jest.fn<(h: string, n: string, q: Record<string, unknown>) => Promise<unknown>>();
const mockInsertValues = jest.fn<(v: unknown) => Promise<void>>(async () => undefined);
let readerConfigured = true;

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  db: { insert: jest.fn(() => ({ values: mockInsertValues })) },
  schema: { ecosystemSearchMiss: { _: 'ecosystem_search_misses' } },
  isPublicReaderConfigured: () => readerConfigured,
  searchPublicListings: mockSearch,
  listPublicCategories: mockCategories,
  listPublicListingsForSitemap: mockSitemap,
  getPublicListing: mockListing,
  getPublicListedVersion: mockListedVersion,
  listPublicReviews: mockReviews,
  REVIEW_SORTS: ['helpful', 'recent', 'highest', 'lowest'],
  normalizeQuery: (q: string | undefined) => (q ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
  DIRECTORY_SORTS: ['relevance', 'rating', 'installs', 'updated', 'name'],
  DIRECTORY_TIERS: ['official', 'verified', 'community', 'unverified'],
}));

const rateLimitOptions: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  rateLimitByOrg: (opts: Record<string, unknown>) => {
    rateLimitOptions.push(opts);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: express.Request, res: express.Response) => {
    try {
      await handler({ req, res, ctx: { log: () => undefined }, orgId: '', userId: '' });
    } catch {
      res.status(500).json({ success: false });
    }
  },
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ host: 'registry', port: 5000, http: true }) },
}));

class ImageVerificationError extends Error {}
class SbomBusyError extends Error {}
const mockFetchSbom = jest.fn<(repo: string, digest: string, ..._rest: unknown[]) => Promise<Record<string, unknown>>>();
jest.unstable_mockModule('../src/helpers/supply-chain.js', () => ({
  fetchPublicImageSbom: mockFetchSbom,
  ImageVerificationError,
  SbomBusyError,
}));

const { createPublicDirectoryRoutes } = await import('../src/routes/public-directory.js');

let base = '';
let server: ReturnType<express.Express['listen']>;

beforeAll(async () => {
  const app = express();
  app.use('/public', createPublicDirectoryRoutes());
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const EMPTY = {
  items: [],
  total: 0,
  nextCursor: null,
  facets: { category: {}, tier: {}, license: {}, computeType: {}, needsSecrets: { true: 0, false: 0 } },
};

beforeEach(() => {
  jest.clearAllMocks();
  readerConfigured = true;
  delete process.env.PUBLIC_DIRECTORY_ENABLED;
  mockSearch.mockResolvedValue(EMPTY);
});

describe('availability', () => {
  it.each([
    ['the flag is off', () => { process.env.PUBLIC_DIRECTORY_ENABLED = 'false'; }],
    ['the reader login is not configured', () => { readerConfigured = false; }],
  ])('answers 404 on every route when %s', async (_label, setup) => {
    setup();
    for (const path of ['/plugins', '/plugins/categories', '/plugins/sitemap', '/plugins/acme/trivy']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('is on by default when the reader is configured', async () => {
    expect((await fetch(`${base}/plugins`)).status).toBe(200);
  });

  it('rate limits per trusted IP with a configurable budget', () => {
    expect(rateLimitOptions[0]).toMatchObject({ name: 'public-directory', max: 120, windowMs: 60_000 });
  });
});

describe('GET /public/plugins', () => {
  it('maps the query onto the search, and marks the answer publicly cacheable', async () => {
    const res = await fetch(`${base}/plugins?q=trivy&category=security&tier=official&needsSecrets=false&minRating=4&sort=rating&limit=100`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=60/);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      q: 'trivy', category: 'security', tier: 'official', needsSecrets: false, minRating: 4, sort: 'rating', limit: 100,
    }));
    expect(((await res.json()) as any).data).toEqual(EMPTY);
  });

  it('takes the first value of a repeated parameter', async () => {
    await fetch(`${base}/plugins?tier=community&tier=official`);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ tier: 'community' }));
  });

  it.each([
    'tier=superadmin', 'sort=random', 'minRating=9', 'category=Sec;DROP', 'cursor=<script>', 'license=%00',
  ])('refuses %s with 400 and never queries', async (qs) => {
    expect((await fetch(`${base}/plugins?${qs}`)).status).toBe(400);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('logs a zero-result first-page query, but not a browse or a later page', async () => {
    await fetch(`${base}/plugins?q=${encodeURIComponent('  terafrom  ')}&category=iac`);
    expect(mockInsertValues).toHaveBeenCalledWith({ query: 'terafrom', category: 'iac' });

    mockInsertValues.mockClear();
    await fetch(`${base}/plugins`);
    await fetch(`${base}/plugins?q=x&cursor=eyJvIjoyNH0`);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('still answers when the miss log fails', async () => {
    mockInsertValues.mockRejectedValueOnce(new Error('db down'));
    expect((await fetch(`${base}/plugins?q=nothing`)).status).toBe(200);
  });
});

describe('categories + sitemap', () => {
  it('serves categories in the envelope the pages read', async () => {
    mockCategories.mockResolvedValue([{ id: 'security', count: 3, top: [] }]);
    const res = await fetch(`${base}/plugins/categories`);
    expect(((await res.json()) as any).data).toEqual({ categories: [{ id: 'security', count: 3, top: [] }] });
    expect(res.headers.get('cache-control')).toMatch(/^public/);
  });

  it('serves every listing for the sitemap in one call', async () => {
    mockSitemap.mockResolvedValue([{ publisher: 'acme', name: 'trivy', updatedAt: '2026-09-21T00:00:00.000Z' }]);
    const res = await fetch(`${base}/plugins/sitemap`);
    expect(((await res.json()) as any).data).toEqual({ entries: [{ publisher: 'acme', name: 'trivy', updatedAt: '2026-09-21T00:00:00.000Z' }] });
  });
});

describe('GET /public/plugins/:publisher/:name', () => {
  it('serves a listed plugin', async () => {
    mockListing.mockResolvedValue({ name: 'trivy' });
    const res = await fetch(`${base}/plugins/pipeline-builder/trivy`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toEqual({ listing: { name: 'trivy' } });
    expect(mockListing).toHaveBeenCalledWith('pipeline-builder', 'trivy');
  });

  it('answers 404 for an unlisted plugin', async () => {
    mockListing.mockResolvedValue(null);
    expect((await fetch(`${base}/plugins/acme/nope`)).status).toBe(404);
  });

  it.each(['/plugins/ACME/trivy', '/plugins/acme/..%2Fsecret', `/plugins/acme/${'a'.repeat(200)}`])(
    'treats a malformed path %s as not listed (404) without querying', async (path) => {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
      expect(mockListing).not.toHaveBeenCalled();
    });
});

describe('GET /public/plugins/:publisher/:name/versions/:version/sbom', () => {
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const sbomUrl = () => `${base}/plugins/acme/trivy/versions/1.2.3/sbom`;

  beforeEach(() => {
    mockListedVersion.mockResolvedValue({ imageRepository: 'public/acme/trivy', imageDigest: DIGEST });
  });

  it('downloads the verified SBOM of a listed version', async () => {
    mockFetchSbom.mockResolvedValue({ spdxVersion: 'SPDX-2.3' });
    const res = await fetch(sbomUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/spdx\+json/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="acme-trivy-1.2.3.spdx.json"');
    expect((await res.json()) as any).toEqual({ spdxVersion: 'SPDX-2.3' });
    expect(mockFetchSbom).toHaveBeenCalledWith('public/acme/trivy', DIGEST, expect.anything());
  });

  it('answers 404 for a yanked or unknown version, and for a malformed one', async () => {
    mockListedVersion.mockResolvedValue(null);
    expect((await fetch(sbomUrl())).status).toBe(404);
    expect((await fetch(`${base}/plugins/acme/trivy/versions/latest/sbom`)).status).toBe(404);
    expect(mockFetchSbom).not.toHaveBeenCalled();
  });

  it('answers 409 when the attestation does not verify', async () => {
    mockFetchSbom.mockRejectedValue(new ImageVerificationError('no attestation'));
    const res = await fetch(sbomUrl());
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe('IMAGE_VERIFICATION_FAILED');
  });

  it('answers 503 with Retry-After when verification is saturated', async () => {
    mockFetchSbom.mockRejectedValue(new SbomBusyError('busy'));
    const res = await fetch(sbomUrl());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });
});

describe('GET /public/plugins/:publisher/:name/reviews', () => {
  const PAGE = { reviews: [{ id: 'r1', rating: 5, author: { displayName: 'alice' } }], total: 1, nextCursor: null };

  it('serves a page of published reviews with the validated query, publicly cacheable', async () => {
    mockReviews.mockResolvedValue(PAGE);
    const res = await fetch(`${base}/plugins/acme/trivy/reviews?sort=recent&rating=4&limit=5&cursor=eyJvIjoxMH0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/^public, max-age=60/);
    expect(((await res.json()) as any).data).toEqual(PAGE);
    expect(mockReviews).toHaveBeenCalledWith('acme', 'trivy', { sort: 'recent', rating: 4, limit: 5, cursor: 'eyJvIjoxMH0' });
  });

  it('a fresh re-read (?fresh=1, or a credentialed request) is never cacheable (E24)', async () => {
    mockReviews.mockResolvedValue(PAGE);
    const fresh = await fetch(`${base}/plugins/acme/trivy/reviews?fresh=1`);
    expect(fresh.headers.get('cache-control')).toBe('private, no-store');
    const authed = await fetch(`${base}/plugins/acme/trivy/reviews`, { headers: { Authorization: 'Bearer x' } });
    expect(authed.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers 404 when the listing is not public, and for a malformed path', async () => {
    mockReviews.mockResolvedValue(null);
    expect((await fetch(`${base}/plugins/acme/nope/reviews`)).status).toBe(404);
    expect((await fetch(`${base}/plugins/Acme!/x/reviews`)).status).toBe(404);
  });

  it('refuses an invalid sort or star filter', async () => {
    expect((await fetch(`${base}/plugins/acme/trivy/reviews?sort=worst`)).status).toBe(400);
    expect((await fetch(`${base}/plugins/acme/trivy/reviews?rating=6`)).status).toBe(400);
    expect(mockReviews).not.toHaveBeenCalled();
  });
});
