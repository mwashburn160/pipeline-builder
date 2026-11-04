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

const { authorizeAndIssue, storageGateReason } = await import('../src/services/token-service.js');

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

  // The cap is SOFT by QUOTA_STORAGE_GRACE_PCT (10% by default), so enforcement
  // binds at 1,100 rather than at 1,000. Storage is a stock: it never refills,
  // so without the band a downgrade or a cancelled Storage Pack flips an account
  // from working to refused with no room to prune or buy. These two cases pin
  // where the band starts and where it ends.
  it('keeps push AT the nominal cap — the grace band is the point', async () => {
    computeOrgStorageUsage.mockResolvedValue(usage(1000));
    const { token, storageGate } = await authorizeAndIssue(writer, [{ type: 'repository', name: 'org-acme/app', actions: ['pull', 'push'] }], 'u1');
    expect(accessOf(token)).toEqual([{ type: 'repository', name: 'org-acme/app', actions: ['pull', 'push'] }]);
    // Reported against the NOMINAL limit, so the dashboard shows 100% while the
    // push still works — exactly as `automationCalls` behaves inside its band.
    expect(storageGate).toEqual(expect.objectContaining({
      overBudget: false, reason: 'under_budget', usageBytes: 1000, limitBytes: 1000, enforcedBytes: 1100,
    }));
  });

  it('strips push (keeping pull) once published bytes pass the grace band', async () => {
    computeOrgStorageUsage.mockResolvedValue(usage(1100));
    const { token, storageGate } = await authorizeAndIssue(writer, [{ type: 'repository', name: 'org-acme/app', actions: ['pull', 'push'] }], 'u1');
    expect(accessOf(token)).toEqual([{ type: 'repository', name: 'org-acme/app', actions: ['pull'] }]);
    expect(storageGate).toEqual(expect.objectContaining({ overBudget: true, reason: 'over_budget' }));
  });

  it('carries the reason and the byte figures, so a refusal can be explained', async () => {
    // A stripped push reaches the client as a bare 403 that names nothing, so
    // the platform's own record is the only place the reason can live.
    computeOrgStorageUsage.mockResolvedValue(usage(2000));
    const { storageGate } = await authorizeAndIssue(writer, [{ type: 'repository', name: 'org-acme/app', actions: ['push'] }], 'u1');
    expect(storageGateReason(storageGate!)).toBe('push stripped: storage 2.0 KB of 1000 B (including a grace band to 1.1 KB)');
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


/**
 * `storageGateReason` — the one sentence a refusal is explained with.
 *
 * A stripped `push` reaches the client as a bare 403 that names nothing, so the
 * platform's own record is the only place the reason can live. Each arm is
 * pinned because each answers a different operator question.
 */
describe('storageGateReason', () => {
  const d = (over: Partial<Parameters<typeof storageGateReason>[0]>) => storageGateReason({
    overBudget: false, reason: 'under_budget', usageBytes: null, limitBytes: null, enforcedBytes: null, ...over,
  });

  it('names the figures when the cap is what refused', () => {
    expect(d({ overBudget: true, reason: 'over_budget', usageBytes: 2048, limitBytes: 1000, enforcedBytes: 1100 }))
      .toBe('push stripped: storage 2.0 KB of 1000 B (including a grace band to 1.1 KB)');
  });

  it('omits the band when there is none to mention', () => {
    expect(d({ overBudget: true, reason: 'over_budget', usageBytes: 2048, limitBytes: 1000, enforcedBytes: 1000 }))
      .toBe('push stripped: storage 2.0 KB of 1000 B');
  });

  it('distinguishes the three fail-CLOSED reasons, which are not a full cap', () => {
    // An operator answering "why can't this org push?" must be able to tell an
    // over-quota org from an unreadable one — the remedies are opposite.
    expect(d({ overBudget: true, reason: 'quota_unreachable' })).toMatch(/could not be read \(fail-closed\)/);
    expect(d({ overBudget: true, reason: 'usage_incomplete', usageBytes: 10, limitBytes: 1000 }))
      .toMatch(/scan was incomplete, so 10 B of 1000 B under-counts/);
    expect(d({ overBudget: true, reason: 'gate_error' })).toMatch(/gate failed \(fail-closed\)/);
  });

  it('says so plainly when nothing is being enforced', () => {
    expect(d({ reason: 'unlimited', limitBytes: -1 })).toBe('storage is unlimited for this organization');
    expect(d({ reason: 'under_budget', usageBytes: 500, limitBytes: 1000 })).toBe('storage 500 B of 1000 B');
  });
});
