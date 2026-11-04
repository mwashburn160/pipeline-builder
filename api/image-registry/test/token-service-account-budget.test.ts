// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The storage push-gate with `QUOTA_STORAGE_ACCOUNT_BUDGET=true` — D1 of the
 * storage plan.
 *
 * Storage is the ONLY quota without pooling's joint-overshoot guarantee: every
 * namespace is measured against the same pooled cap, so a five-team Pro account
 * could hold 5 × 25 GB against a headline 25 GB, and one Storage Pack raised
 * every namespace's ceiling at once. With the flag on, the gate decides against
 * the ACCOUNT's total, which the quota service's status now carries.
 *
 * A separate file because the flag is read once at module load.
 */

process.env.QUOTA_STORAGE_ACCOUNT_BUDGET = 'true';

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

const quotaCheck = jest.fn<(orgId: string, type: string, auth: string) => Promise<{ limit?: number; used?: number; failOpen?: boolean }>>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: () => ({ check: quotaCheck }),
  getServiceAuthHeader: () => 'Bearer test',
  registerPreviousSecretProbe: () => undefined,
}));

const { authorizeAndIssue } = await import('../src/services/token-service.js');

const writer = { type: 'jwt' as const, orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false, canWritePlugins: true };
const push = [{ type: 'repository' as const, name: 'org-acme/app', actions: ['pull', 'push'] }];
const accessOf = (token: string) =>
  (jwt.decode(token) as { access: Array<{ name: string; actions: string[] }> }).access;

beforeEach(() => {
  jest.clearAllMocks();
  computeOrgStorageUsage.mockResolvedValue({ prefix: 'org-acme/', bytes: 100, repos: 1, blobs: 1, computedAt: 0, incomplete: false });
});

describe('storage push-gate — account budget', () => {
  it('refuses on the ACCOUNT total even when this namespace is small', () => {
    // The namespace holds 100 bytes; the account holds 2,000 against a 1,000
    // cap. Per-namespace enforcement would wave this push through — which is
    // exactly the overshoot D1 closes.
    quotaCheck.mockResolvedValue({ limit: 1000, used: 2000 });
    return authorizeAndIssue(writer, push, 'u1').then(({ token, storageGate }) => {
      expect(accessOf(token)).toEqual([{ type: 'repository', name: 'org-acme/app', actions: ['pull'] }]);
      expect(storageGate).toEqual(expect.objectContaining({ overBudget: true, reason: 'over_budget', usageBytes: 2000 }));
      // It must not also measure the namespace: the account figure is the
      // decision, and the per-namespace walk is the expensive part.
      expect(computeOrgStorageUsage).not.toHaveBeenCalled();
    });
  });

  it('allows the account inside its grace band', async () => {
    quotaCheck.mockResolvedValue({ limit: 1000, used: 1050 });
    const { token } = await authorizeAndIssue(writer, push, 'u1');
    expect(accessOf(token)[0].actions).toEqual(['pull', 'push']);
  });

  it('falls back to the namespace walk when the account total is unknown', async () => {
    // `used: 0` is what a quota service that could not measure returns, and 0 is
    // not a usable account total — so the gate measures rather than concluding
    // the account is empty.
    quotaCheck.mockResolvedValue({ limit: 1000, used: 0 });
    const { token, storageGate } = await authorizeAndIssue(writer, push, 'u1');
    expect(computeOrgStorageUsage).toHaveBeenCalledWith('acme');
    expect(storageGate).toEqual(expect.objectContaining({ usageBytes: 100, reason: 'under_budget' }));
    expect(accessOf(token)[0].actions).toEqual(['pull', 'push']);
  });

  it('still allows an unlimited account without measuring anything', async () => {
    quotaCheck.mockResolvedValue({ limit: -1, used: 9_999 });
    const { token } = await authorizeAndIssue(writer, push, 'u1');
    expect(accessOf(token)[0].actions).toEqual(['pull', 'push']);
    expect(computeOrgStorageUsage).not.toHaveBeenCalled();
  });
});
