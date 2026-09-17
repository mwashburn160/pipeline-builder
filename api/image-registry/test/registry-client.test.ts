// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the registry-client auth caching (Fix 4): a per-repo bearer token
 * (and the axios instance carrying it) must be minted ONCE per scope set and
 * reused for its TTL — so a storage rollup issuing N HEADs against one repo
 * signs one RS256 JWT, not N.
 *
 * token-service (`authorizeAndIssue`) and axios are mocked so no real signing
 * or HTTP happens; we assert on mint / instance-create counts.
 */

// Config reads these at import (loadConfig runs at module top). token-service
// is mocked, so the key material only needs to be present, not valid.
process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.IMAGE_REGISTRY_PORT = '5000';
process.env.REGISTRY_TOKEN_PRIVATE_KEY = 'test-key';
process.env.REGISTRY_TOKEN_CERTIFICATE = 'test-cert';
process.env.REGISTRY_TOKEN_ISSUER = 'test-platform';
process.env.REGISTRY_TOKEN_SERVICE = 'test-registry';
process.env.JWT_SECRET = 'test-jwt-secret';

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // manifest-copy (exercised below over the REAL registry-client) fans out with this.
  runConcurrent: async <T>(items: T[], _n: number, fn: (t: T) => Promise<void>) => {
    for (const item of items) await fn(item);
  },
}));

const authorizeAndIssue = jest.fn<(...a: unknown[]) => Promise<{ token: string }>>()
  .mockResolvedValue({ token: 'minted-token' });
jest.unstable_mockModule('../src/services/token-service.js', () => ({ authorizeAndIssue }));

// axios mock: each create() returns a fresh instance whose verbs delegate to
// shared spies, so a test can route by URL regardless of which cached instance
// (scope set) a call lands on.
type HttpResponse = { data?: unknown; headers: Record<string, string>; status?: number };
const defaultGet = async (): Promise<HttpResponse> => ({
  data: { name: 'r', tags: [] },
  headers: { 'docker-content-digest': 'sha256:x', 'content-type': 'application/json' },
});
const httpGet = jest.fn<(url: string, cfg?: Record<string, unknown>) => Promise<HttpResponse>>();
const httpPut = jest.fn<(url: string, data: unknown, cfg?: { headers?: Record<string, string> }) => Promise<HttpResponse>>();
const httpPost = jest.fn<(url: string, data: unknown, cfg?: Record<string, unknown>) => Promise<HttpResponse>>();
const makeInstance = () => ({
  head: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({ headers: { 'content-length': '123' } }),
  get: (url: string, cfg?: Record<string, unknown>) => httpGet(url, cfg),
  put: (url: string, data: unknown, cfg?: { headers?: Record<string, string> }) => httpPut(url, data, cfg),
  post: (url: string, data: unknown, cfg?: Record<string, unknown>) => httpPost(url, data, cfg),
  delete: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({}),
  defaults: { httpsAgent: {} },
});
const axiosCreate = jest.fn(makeInstance);
jest.unstable_mockModule('axios', () => ({ default: { create: axiosCreate } }));

const { headBlob, listTags, deleteManifest, getManifest } = await import('../src/services/registry-client.js');
const { copyManifestTree } = await import('../src/routes/images/manifest-copy.js');

beforeEach(() => {
  httpGet.mockImplementation(defaultGet);
  httpPut.mockResolvedValue({ headers: {} });
  httpPost.mockResolvedValue({ headers: {}, status: 201 });
});

describe('registry-client auth caching', () => {
  it('mints ONE token + ONE axios instance across repeated same-scope calls', async () => {
    const mintsBefore = authorizeAndIssue.mock.calls.length;
    const createsBefore = axiosCreate.mock.calls.length;

    await headBlob('org-acme/reuse', 'sha256:aaa');
    await headBlob('org-acme/reuse', 'sha256:bbb');
    await headBlob('org-acme/reuse', 'sha256:ccc');

    expect(authorizeAndIssue.mock.calls.length - mintsBefore).toBe(1);
    expect(axiosCreate.mock.calls.length - createsBefore).toBe(1);
  });

  it('shares the cached token across ops that need the same scope (pull)', async () => {
    const mintsBefore = authorizeAndIssue.mock.calls.length;

    // listTags + headBlob on the same repo both need repository:<repo>:pull.
    await listTags('org-acme/shared');
    await headBlob('org-acme/shared', 'sha256:ddd');

    expect(authorizeAndIssue.mock.calls.length - mintsBefore).toBe(1);
  });

  it('mints a DISTINCT token per repo (scopes differ)', async () => {
    const mintsBefore = authorizeAndIssue.mock.calls.length;

    await headBlob('org-acme/a', 'sha256:eee');
    await headBlob('org-acme/b', 'sha256:fff');

    expect(authorizeAndIssue.mock.calls.length - mintsBefore).toBe(2);
  });

  it('mints a DISTINCT token when the actions differ (delete vs pull)', async () => {
    const mintsBefore = authorizeAndIssue.mock.calls.length;

    await headBlob('org-acme/mixed', 'sha256:ggg'); // pull
    await deleteManifest('org-acme/mixed', 'sha256:hhh'); // delete

    expect(authorizeAndIssue.mock.calls.length - mintsBefore).toBe(2);
  });
});

describe('registry-client manifest bytes (tag-copy must not change digests)', () => {
  const hex = (c: string) => `sha256:${c.repeat(64)}`;
  const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
  const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
  // Deliberately NON-canonical: odd whitespace, a trailing newline, and keys in a
  // non-alphabetical order with `mediaType` last. JSON.parse→JSON.stringify would
  // rewrite every one of these, producing a different sha256 digest.
  const childRaw = `{\n   "schemaVersion" : 2,\n\t"layers": [ {"digest":"${hex('b')}", "size": 7} ],\n  "config":{"digest":"${hex('a')}","size":1},\n  "mediaType": "${OCI_MANIFEST}"\n}\n`;
  const indexRaw = `{ "manifests" : [ {"digest": "${hex('c')}", "platform": {"os":"linux","architecture":"arm64"}} ],   "schemaVersion":2 }`;

  /** Serve manifests as the registry does for responseType 'arraybuffer': raw bytes. */
  const serve = (byRef: Record<string, { raw: string; mediaType: string }>) =>
    httpGet.mockImplementation(async (url) => {
      const ref = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const m = byRef[ref];
      if (!m) throw Object.assign(new Error('404'), { response: { status: 404 } });
      return { data: Buffer.from(m.raw, 'utf-8'), headers: { 'docker-content-digest': `digest-of-${ref}`, 'content-type': m.mediaType } };
    });

  /** The bytes + Content-Type of the PUT that targeted `ref`. */
  const putFor = (ref: string) => {
    const call = httpPut.mock.calls.find(([url]) => url.endsWith(`/manifests/${encodeURIComponent(ref)}`));
    expect(call).toBeDefined();
    const [, data, cfg] = call!;
    return { bytes: Buffer.isBuffer(data) ? data.toString('utf-8') : data, contentType: cfg?.headers?.['Content-Type'] };
  };

  it('getManifest exposes the exact served bytes alongside the parsed body', async () => {
    serve({ v1: { raw: childRaw, mediaType: OCI_MANIFEST } });
    const m = await getManifest('org-acme/raw', 'v1');
    expect(m.raw.toString('utf-8')).toBe(childRaw);
    expect((m.body as { config: { digest: string } }).config.digest).toBe(hex('a'));
    expect(m.mediaType).toBe(OCI_MANIFEST);
  });

  it('single-arch copy PUTs the byte-identical manifest with its original Content-Type', async () => {
    serve({ v1: { raw: childRaw, mediaType: OCI_MANIFEST } });
    const src = await getManifest('org-acme/src', 'v1');
    await copyManifestTree(src, 'org-acme/src', 'org-acme/dst', 'v2');

    const put = putFor('v2');
    expect(put.bytes).toBe(childRaw);
    expect(put.contentType).toBe(OCI_MANIFEST);
  });

  it('multi-arch copy PUTs the index AND each child (by digest) byte-identically', async () => {
    serve({
      v1: { raw: indexRaw, mediaType: OCI_INDEX },
      [hex('c')]: { raw: childRaw, mediaType: OCI_MANIFEST },
    });
    const src = await getManifest('org-acme/multi', 'v1');
    const counts = await copyManifestTree(src, 'org-acme/multi', 'org-acme/multi-dst', 'v2');
    expect(counts).toEqual({ manifests: 2, blobs: 2 });

    const child = putFor(hex('c'));
    expect(child.bytes).toBe(childRaw);
    expect(child.contentType).toBe(OCI_MANIFEST);
    const index = putFor('v2');
    expect(index.bytes).toBe(indexRaw);
    expect(index.contentType).toBe(OCI_INDEX);
  });
});
