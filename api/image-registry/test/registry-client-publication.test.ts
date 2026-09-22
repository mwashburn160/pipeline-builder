// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the registry-client calls the public/* publication machinery added:
 * repository-scoped management tokens for cosign
 * (push and pull-only), tag-only delete (yank), small-blob upload (publication
 * records), JSON blob reads, and manifest HEAD.
 *
 * token-service and axios are mocked; the assertions pin the exact scopes and
 * HTTP requests issued.
 */

process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.IMAGE_REGISTRY_PORT = '5000';
process.env.IMAGE_REGISTRY_HTTP = 'true';
process.env.REGISTRY_TOKEN_PRIVATE_KEY = 'test-key';
process.env.REGISTRY_TOKEN_CERTIFICATE = 'test-cert';
process.env.JWT_SECRET = 'test-jwt-secret';

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

type Scope = { type: string; name: string; actions: string[] };
const authorizeAndIssue = jest.fn<(identity: unknown, scopes: Scope[], account: string) => Promise<{ token: string }>>()
  .mockImplementation(async (_i, scopes) => ({ token: `tok:${scopes.map((s) => `${s.name}:${s.actions.join(',')}`).join('|')}` }));
jest.unstable_mockModule('../src/services/token-service.js', () => ({ authorizeAndIssue }));

type HttpResponse = { data?: unknown; headers: Record<string, string>; status?: number };
const httpHead = jest.fn<(url: string, cfg?: Record<string, unknown>) => Promise<HttpResponse>>();
const httpGet = jest.fn<(url: string, cfg?: Record<string, unknown>) => Promise<HttpResponse>>();
const httpPut = jest.fn<(url: string, data: unknown, cfg?: Record<string, unknown>) => Promise<HttpResponse>>();
const httpPost = jest.fn<(url: string, data: unknown, cfg?: Record<string, unknown>) => Promise<HttpResponse>>();
const httpDelete = jest.fn<(url: string) => Promise<HttpResponse>>();
const axiosCreate = jest.fn((cfg: { headers?: Record<string, string> }) => ({
  head: (url: string, c?: Record<string, unknown>) => httpHead(url, { ...c, auth: cfg.headers?.Authorization }),
  get: (url: string, c?: Record<string, unknown>) => httpGet(url, { ...c, auth: cfg.headers?.Authorization }),
  put: (url: string, d: unknown, c?: Record<string, unknown>) => httpPut(url, d, { ...c, auth: cfg.headers?.Authorization }),
  post: (url: string, d: unknown, c?: Record<string, unknown>) => httpPost(url, d, { ...c, auth: cfg.headers?.Authorization }),
  delete: (url: string) => httpDelete(url),
  defaults: { httpsAgent: {} },
}));
jest.unstable_mockModule('axios', () => ({ default: { create: axiosCreate } }));

const {
  mintRepositoryPushToken,
  mintRepositoryPullToken,
  deleteTag,
  uploadSmallBlob,
  getBlobJson,
  headManifest,
  isNotFound,
} = await import('../src/services/registry-client.js');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const axios404 = () => Object.assign(new Error('404'), { response: { status: 404 } });
const axios500 = () => Object.assign(new Error('500'), { response: { status: 500 } });

beforeEach(() => {
  httpHead.mockReset();
  httpGet.mockReset();
  httpPut.mockReset().mockResolvedValue({ headers: {}, status: 201 });
  httpPost.mockReset();
  httpDelete.mockReset().mockResolvedValue({ headers: {} });
  authorizeAndIssue.mockClear();
});

describe('repository-scoped cosign tokens', () => {
  it('mints a management pull+push token for exactly one repository', async () => {
    expect(await mintRepositoryPushToken('public/acme/scanner')).toBe('tok:public/acme/scanner:pull,push');
    expect(authorizeAndIssue).toHaveBeenCalledWith(
      { type: 'management' },
      [{ type: 'repository', name: 'public/acme/scanner', actions: ['pull', 'push'] }],
      'pipeline-image-registry-management',
    );
  });

  it('mints a PULL-ONLY management token for verification', async () => {
    expect(await mintRepositoryPullToken('org-acme/scanner')).toBe('tok:org-acme/scanner:pull');
    expect(authorizeAndIssue).toHaveBeenCalledWith(
      { type: 'management' },
      [{ type: 'repository', name: 'org-acme/scanner', actions: ['pull'] }],
      'pipeline-image-registry-management',
    );
  });

  it('mints fresh on every call (never cached beyond the one operation)', async () => {
    await mintRepositoryPullToken('org-acme/scanner');
    await mintRepositoryPullToken('org-acme/scanner');
    expect(authorizeAndIssue).toHaveBeenCalledTimes(2);
  });

  it.each(['../system/x', 'org-acme//x', '/org-acme/x', 'org-acme/x/'])('refuses a malformed repository name %s before minting', (repo) => {
    expect(() => mintRepositoryPushToken(repo)).toThrow(/Invalid repository name/);
    expect(() => mintRepositoryPullToken(repo)).toThrow(/Invalid repository name/);
    expect(authorizeAndIssue).not.toHaveBeenCalled();
  });
});

describe('deleteTag', () => {
  it('DELETEs the tag reference with a delete-scoped token', async () => {
    await deleteTag('public/acme/scanner', '1.2.0');
    expect(httpDelete).toHaveBeenCalledWith('/v2/public/acme/scanner/manifests/1.2.0');
    expect(authorizeAndIssue).toHaveBeenCalledWith(
      { type: 'management' },
      [{ type: 'repository', name: 'public/acme/scanner', actions: ['delete'] }],
      expect.any(String),
    );
  });

  it('refuses a digest (that would delete the manifest, not just the tag)', async () => {
    await expect(deleteTag('public/acme/scanner', DIGEST)).rejects.toThrow(/takes a tag, not a digest/);
    expect(httpDelete).not.toHaveBeenCalled();
  });

  it('propagates a registry error', async () => {
    httpDelete.mockRejectedValueOnce(axios500());
    await expect(deleteTag('public/acme/scanner', '1.2.1')).rejects.toThrow('500');
  });
});

describe('uploadSmallBlob', () => {
  const repo = 'registry-meta/publications/acme/scanner';
  const bytes = Buffer.from('{}');

  it('skips the upload when the blob is already in the repository', async () => {
    httpHead.mockResolvedValueOnce({ headers: {} });
    await uploadSmallBlob(repo, DIGEST, bytes);
    expect(httpHead).toHaveBeenCalledWith(`/v2/${repo}/blobs/${encodeURIComponent(DIGEST)}`, expect.anything());
    expect(httpPost).not.toHaveBeenCalled();
    expect(httpPut).not.toHaveBeenCalled();
  });

  it('opens an upload session and PUTs the bytes with the digest (relative Location)', async () => {
    httpHead.mockRejectedValueOnce(axios404());
    httpPost.mockResolvedValueOnce({ headers: { location: `/v2/${repo}/blobs/uploads/uuid-1?_state=abc` }, status: 202 });
    await uploadSmallBlob(repo, DIGEST, bytes);
    expect(httpPost).toHaveBeenCalledWith(`/v2/${repo}/blobs/uploads/`, null, expect.objectContaining({ validateStatus: expect.any(Function) }));
    const [url, body, cfg] = httpPut.mock.calls[0];
    expect(url).toBe(`/v2/${repo}/blobs/uploads/uuid-1?_state=abc&digest=${encodeURIComponent(DIGEST)}`);
    expect(body).toBe(bytes);
    expect((cfg as { headers: Record<string, string> }).headers['Content-Type']).toBe('application/octet-stream');
    const post = httpPost.mock.calls[0][2] as { validateStatus: (s: number) => boolean };
    expect(post.validateStatus(202)).toBe(true);
    expect(post.validateStatus(201)).toBe(false);
    const put = cfg as { validateStatus: (s: number) => boolean };
    expect(put.validateStatus(201)).toBe(true);
    expect(put.validateStatus(202)).toBe(false);
  });

  it('accepts an absolute Location on the registry origin', async () => {
    httpHead.mockRejectedValueOnce(axios404());
    httpPost.mockResolvedValueOnce({ headers: { location: `http://localhost:5000/v2/${repo}/blobs/uploads/uuid-2` }, status: 202 });
    await uploadSmallBlob(repo, DIGEST, bytes);
    expect(httpPut.mock.calls[0][0]).toBe(`/v2/${repo}/blobs/uploads/uuid-2?digest=${encodeURIComponent(DIGEST)}`);
  });

  it('never follows an upload Location to another host', async () => {
    httpHead.mockRejectedValueOnce(axios404());
    httpPost.mockResolvedValueOnce({ headers: { location: 'http://evil.example/steal' }, status: 202 });
    await expect(uploadSmallBlob(repo, DIGEST, bytes)).rejects.toThrow(/is not the registry/);
    expect(httpPut).not.toHaveBeenCalled();
  });

  it('fails when the registry opens no upload session', async () => {
    httpHead.mockRejectedValueOnce(axios404());
    httpPost.mockResolvedValueOnce({ headers: {}, status: 202 });
    await expect(uploadSmallBlob(repo, DIGEST, bytes)).rejects.toThrow(/opened no upload session/);
  });

  it('propagates a non-404 HEAD failure without uploading', async () => {
    httpHead.mockRejectedValueOnce(axios500());
    await expect(uploadSmallBlob(repo, DIGEST, bytes)).rejects.toThrow('500');
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('refuses a malformed digest before any request', async () => {
    await expect(uploadSmallBlob(repo, 'sha256:../../x', bytes)).rejects.toThrow(/Invalid digest format/);
    expect(httpHead).not.toHaveBeenCalled();
  });
});

describe('getBlobJson', () => {
  it('GETs a small blob as JSON with a 1 MB cap', async () => {
    httpGet.mockResolvedValueOnce({ data: { created: '2026-01-01' }, headers: {} });
    expect(await getBlobJson('org-acme/x', DIGEST)).toEqual({ created: '2026-01-01' });
    expect(httpGet).toHaveBeenCalledWith(
      `/v2/org-acme/x/blobs/${encodeURIComponent(DIGEST)}`,
      expect.objectContaining({ maxContentLength: 1024 * 1024, responseType: 'json' }),
    );
  });
});

describe('headManifest', () => {
  it('returns the digest from Docker-Content-Digest', async () => {
    httpHead.mockResolvedValueOnce({ headers: { 'docker-content-digest': DIGEST } });
    expect(await headManifest('public/acme/scanner', '1.2.0')).toEqual({ digest: DIGEST });
  });

  it('falls back to GET when HEAD omits the digest', async () => {
    httpHead.mockResolvedValueOnce({ headers: {} });
    httpGet.mockResolvedValueOnce({ data: Buffer.from('{}'), headers: { 'docker-content-digest': DIGEST, 'content-type': 'x' } });
    expect(await headManifest('public/acme/scanner', '1.2.1')).toEqual({ digest: DIGEST });
  });

  it('returns null on 404 and rethrows anything else', async () => {
    httpHead.mockRejectedValueOnce(axios404());
    expect(await headManifest('public/acme/scanner', 'nope')).toBeNull();
    httpHead.mockRejectedValueOnce(axios500());
    await expect(headManifest('public/acme/scanner', 'boom')).rejects.toThrow('500');
  });
});

describe('isNotFound', () => {
  it('recognizes only an axios-shaped 404', () => {
    expect(isNotFound(axios404())).toBe(true);
    expect(isNotFound(axios500())).toBe(false);
    expect(isNotFound({ statusCode: 404 })).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound('404')).toBe(false);
  });
});
