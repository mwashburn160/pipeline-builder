// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared platform org-hierarchy HTTP lookups
 * ({@link fetchParentOrgId}, {@link fetchOrgDescendants}).
 *
 * The transport ({@link InternalHttpClient}) and the service-auth header signer
 * are mocked so no real network call or JWT signing happens — these tests focus
 * on the response handling: status-code gating, the descendants element-level
 * validation (the trust boundary), and the throw-on-transport contract that
 * lets each caller keep its own fallback policy.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock logger to avoid Winston open handles.
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// Stub the service-auth header so no JWT signing / secret loading is required.
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  getServiceAuthHeader: jest.fn(() => 'Bearer test-token'),
}));

// Mock the shared HTTP client: a single controllable `get` spy backs every
// InternalHttpClient instance the helpers construct.
const mockGet = jest.fn<(...args: any[]) => any>();
jest.unstable_mockModule('../src/services/http-client.js', () => ({
  InternalHttpClient: jest.fn().mockImplementation(() => ({ get: mockGet })),
}));

const { fetchParentOrgId, fetchOrgDescendants } = await import('../src/helpers/org-hierarchy-http.js');

const OPTS = { service: { host: 'platform', port: 3000 }, serviceName: 'reporting' as const };

beforeEach(() => {
  mockGet.mockReset();
});

describe('fetchOrgDescendants', () => {
  it('returns the validated id list on the happy path', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { data: { orgIds: ['self', 'child-1', 'child-2'] } }, headers: {} });
    await expect(fetchOrgDescendants('self', OPTS)).resolves.toEqual(['self', 'child-1', 'child-2']);
  });

  it('filters out non-string elements (trust-boundary validation)', async () => {
    mockGet.mockResolvedValue({
      statusCode: 200,
      body: { data: { orgIds: ['self', 42, null, 'child-1', { id: 'x' }, undefined, 'child-2'] } },
      headers: {},
    });
    await expect(fetchOrgDescendants('self', OPTS)).resolves.toEqual(['self', 'child-1', 'child-2']);
  });

  it('returns undefined when validation collapses the subtree to <= 1 real id', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { data: { orgIds: ['self', 99, false] } }, headers: {} });
    await expect(fetchOrgDescendants('self', OPTS)).resolves.toBeUndefined();
  });

  it('returns undefined for a single-org subtree (no descendants)', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { data: { orgIds: ['self'] } }, headers: {} });
    await expect(fetchOrgDescendants('self', OPTS)).resolves.toBeUndefined();
  });

  it('returns undefined when orgIds is not an array', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { data: { orgIds: 'not-an-array' } }, headers: {} });
    await expect(fetchOrgDescendants('self', OPTS)).resolves.toBeUndefined();
  });

  it('returns undefined on a non-2xx response', async () => {
    mockGet.mockResolvedValue({ statusCode: 500, body: {}, headers: {} });
    await expect(fetchOrgDescendants('self', OPTS)).resolves.toBeUndefined();
  });

  it('propagates a transport failure so the caller can degrade to its safe default', async () => {
    // Matches fetchParentOrgId's contract: unreachable/timeout throws here; the
    // caller (reporting/compliance) catches and falls back to single-org.
    mockGet.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(fetchOrgDescendants('self', OPTS)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('fetchParentOrgId', () => {
  it('returns the parent id on the happy path', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { data: { parentOrgId: 'parent-1' } }, headers: {} });
    await expect(fetchParentOrgId('child', OPTS)).resolves.toBe('parent-1');
  });

  it('returns undefined for a root org (null parent)', async () => {
    mockGet.mockResolvedValue({ statusCode: 200, body: { data: { parentOrgId: null } }, headers: {} });
    await expect(fetchParentOrgId('root', OPTS)).resolves.toBeUndefined();
  });

  it('returns undefined on a non-2xx response', async () => {
    mockGet.mockResolvedValue({ statusCode: 404, body: {}, headers: {} });
    await expect(fetchParentOrgId('child', OPTS)).resolves.toBeUndefined();
  });

  it('propagates a transport failure', async () => {
    mockGet.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(fetchParentOrgId('child', OPTS)).rejects.toThrow('ETIMEDOUT');
  });
});
