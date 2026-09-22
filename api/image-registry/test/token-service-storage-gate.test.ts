// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `/token` storage push-gate (services/token-service `authorizeAndIssue`).
 * Plugin ecosystem the usage compared against an org's `storageBytes` cap is
 * the COMBINED rollup (its own `org-<id>/*` namespace plus the `public/*`
 * repositories it publishes), so a publisher cannot dodge its cap by publishing.
 * The gate fails CLOSED: an unreachable quota service or an incomplete rollup
 * (e.g. an unreadable publication record) strips `push`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { TOKEN_SIGNING_CERT_PEM, TOKEN_SIGNING_PRIVATE_KEY_PEM } from './helpers/token-signing-fixture.js';

jest.unstable_mockModule('../src/config/index.js', () => ({
  config: {
    registry: { host: 'registry', port: 5000, http: true, insecure: false },
    tokenSigning: {
      privateKeyPem: TOKEN_SIGNING_PRIVATE_KEY_PEM,
      certificatePem: TOKEN_SIGNING_CERT_PEM,
      issuer: 'test-platform',
      service: 'test-registry',
      expiresInSeconds: 300,
    },
  },
}));

type Usage = { prefix: string; bytes: number; repos: number; blobs: number; computedAt: number; incomplete: boolean };
const computeOrgStorageUsage = jest.fn<(orgId: string) => Promise<Usage>>();
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({ computeOrgStorageUsage }));

const quotaCheck = jest.fn<(orgId: string, type: string, auth: string) => Promise<{ limit?: number; failOpen?: boolean }>>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: () => ({ check: quotaCheck }),
  getServiceAuthHeader: () => 'Bearer test',
  registerPreviousSecretProbe: () => undefined,
}));

const { authorizeAndIssue } = await import('../src/services/token-service.js');

const writer = { type: 'jwt' as const, orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false, canWritePlugins: true };
const usage = (bytes: number, incomplete = false): Usage => ({ prefix: 'org-acme/', bytes, repos: 2, blobs: 3, computedAt: 0, incomplete });

const accessOf = (token: string) =>
  (jwt.decode(token) as { access: Array<{ name: string; actions: string[] }> }).access;

beforeEach(() => {
  jest.clearAllMocks();
  quotaCheck.mockResolvedValue({ limit: 1000 });
  computeOrgStorageUsage.mockResolvedValue(usage(500));
});

describe('storage push-gate', () => {
  it('measures the org\'s COMBINED (own + published) rollup and keeps push under the cap', async () => {
    const { token } = await authorizeAndIssue(writer, [{ type: 'repository', name: 'org-acme/app', actions: ['pull', 'push'] }], 'u1');
    expect(quotaCheck).toHaveBeenCalledWith('acme', 'storageBytes', 'Bearer test');
    expect(computeOrgStorageUsage).toHaveBeenCalledWith('acme');
    expect(accessOf(token)).toEqual([{ type: 'repository', name: 'org-acme/app', actions: ['pull', 'push'] }]);
  });

  it('strips push (keeping pull) once published bytes take the org to its cap', async () => {
    computeOrgStorageUsage.mockResolvedValue(usage(1000));
    const { token } = await authorizeAndIssue(writer, [{ type: 'repository', name: 'org-acme/app', actions: ['pull', 'push'] }], 'u1');
    expect(accessOf(token)).toEqual([{ type: 'repository', name: 'org-acme/app', actions: ['pull'] }]);
  });

  it('fails closed on an incomplete rollup (e.g. an unreadable publication record)', async () => {
    computeOrgStorageUsage.mockResolvedValue(usage(10, true));
    const { token } = await authorizeAndIssue(writer, [{ type: 'repository', name: 'org-acme/app', actions: ['push'] }], 'u1');
    expect(accessOf(token)).toEqual([]);
  });

  it('fails closed when the quota service is unreachable', async () => {
    quotaCheck.mockResolvedValue({ failOpen: true });
    const { token } = await authorizeAndIssue(writer, [{ type: 'repository', name: 'org-acme/app', actions: ['pull', 'push'] }], 'u1');
    expect(accessOf(token)[0].actions).toEqual(['pull']);
    expect(computeOrgStorageUsage).not.toHaveBeenCalled();
  });

  it('fails closed when the gate itself throws', async () => {
    computeOrgStorageUsage.mockRejectedValue(new Error('registry down'));
    const { token } = await authorizeAndIssue(writer, [{ type: 'repository', name: 'org-acme/app', actions: ['pull', 'push'] }], 'u1');
    expect(accessOf(token)[0].actions).toEqual(['pull']);
  });

  it('does not measure for an unlimited (-1) org', async () => {
    quotaCheck.mockResolvedValue({ limit: -1 });
    const { token } = await authorizeAndIssue(writer, [{ type: 'repository', name: 'org-acme/app', actions: ['push'] }], 'u1');
    expect(accessOf(token)[0].actions).toEqual(['push']);
    expect(computeOrgStorageUsage).not.toHaveBeenCalled();
  });

  it('measures at most once per token, however many org scopes carry push', async () => {
    await authorizeAndIssue(writer, [
      { type: 'repository', name: 'org-acme/a', actions: ['push'] },
      { type: 'repository', name: 'org-acme/b', actions: ['push'] },
    ], 'u1');
    expect(computeOrgStorageUsage).toHaveBeenCalledTimes(1);
  });

  it('never runs for pull-only scopes, including public/* pulls', async () => {
    const { token } = await authorizeAndIssue(writer, [
      { type: 'repository', name: 'public/acme/scanner', actions: ['pull', 'push'] },
      { type: 'repository', name: 'org-acme/app', actions: ['pull'] },
    ], 'u1');
    expect(quotaCheck).not.toHaveBeenCalled();
    expect(accessOf(token)).toEqual([
      { type: 'repository', name: 'public/acme/scanner', actions: ['pull'] },
      { type: 'repository', name: 'org-acme/app', actions: ['pull'] },
    ]);
  });

  it('never gates the management identity (the one writer of public/*)', async () => {
    const { token } = await authorizeAndIssue({ type: 'management' },
      [{ type: 'repository', name: 'public/acme/scanner', actions: ['pull', 'push'] }], 'pipeline-image-registry-management');
    expect(quotaCheck).not.toHaveBeenCalled();
    expect(accessOf(token)[0].actions).toEqual(['pull', 'push']);
    expect((jwt.decode(token) as { sub: string }).sub).toBe('management');
  });
});
