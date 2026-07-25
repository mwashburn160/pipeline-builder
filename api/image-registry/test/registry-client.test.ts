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

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const authorizeAndIssue = jest.fn<(...a: unknown[]) => Promise<{ token: string }>>()
  .mockResolvedValue({ token: 'minted-token' });
jest.unstable_mockModule('../src/services/token-service.js', () => ({ authorizeAndIssue }));

// axios mock: each create() returns a fresh instance with jest'd verbs.
const makeInstance = () => ({
  head: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({ headers: { 'content-length': '123' } }),
  get: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({
    data: { name: 'r', tags: [] },
    headers: { 'docker-content-digest': 'sha256:x', 'content-type': 'application/json' },
  }),
  delete: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({}),
  defaults: { httpsAgent: {} },
});
const axiosCreate = jest.fn(makeInstance);
jest.unstable_mockModule('axios', () => ({ default: { create: axiosCreate } }));

const { headBlob, listTags, deleteManifest } = await import('../src/services/registry-client.js');

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
