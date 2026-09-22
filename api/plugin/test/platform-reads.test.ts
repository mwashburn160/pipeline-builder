// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/ecosystem/platform-reads.ts answers null — never a guess — whenever
 * platform can't give a complete, well-formed answer, so each caller can pick
 * its own fail policy (Verified eligibility FAILS CLOSED on null; the approver
 * count shows "unknown"). Every malformed/partial/error shape below must be null.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const get = jest.fn<AnyFn>();
const ctorArgs: unknown[] = [];
class FakeClient {
  constructor(opts: unknown) { ctorArgs.push(opts); }
  get(...a: unknown[]) { return get(...a); }
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  InternalHttpClient: FakeClient,
  getServiceAuthHeader: () => 'Bearer svc',
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

const { httpPlatformReads, platformReads, setPlatformReadsForTests } = await import('../src/services/ecosystem/platform-reads.js');

const ok = (data: unknown, statusCode = 200) => ({ statusCode, body: { data } });

beforeEach(() => {
  get.mockReset();
  ctorArgs.length = 0;
});

describe('eligibility (Verified application facts)', () => {
  it('returns the facts, dropping non-string domains, from platform over the service token', async () => {
    get.mockResolvedValue(ok({ verifiedDomains: ['acme.com', 7, 'acme.io'], owners: 2, ownersWithMfa: 1 }));
    await expect(httpPlatformReads.eligibility('org/1')).resolves.toEqual({ verifiedDomains: ['acme.com', 'acme.io'], owners: 2, ownersWithMfa: 1 });
    expect(get).toHaveBeenCalledWith('/internal/ecosystem/publisher-eligibility/org%2F1', { headers: { Authorization: 'Bearer svc' } });
    expect(ctorArgs[0]).toMatchObject({ host: 'platform', port: 3000, timeout: 5_000 });
  });

  it.each([
    ['a 4xx/5xx', ok({ verifiedDomains: [], owners: 1, ownersWithMfa: 1 }, 503)],
    ['no data', { statusCode: 200, body: {} }],
    ['no body', { statusCode: 200, body: undefined }],
    ['domains not an array', ok({ verifiedDomains: 'acme.com', owners: 1, ownersWithMfa: 1 })],
    ['a missing owner count', ok({ verifiedDomains: [], ownersWithMfa: 1 })],
    ['a negative owner count', ok({ verifiedDomains: [], owners: -1, ownersWithMfa: 0 })],
    ['a non-finite MFA count', ok({ verifiedDomains: [], owners: 1, ownersWithMfa: Number.POSITIVE_INFINITY })],
    ['a string MFA count', ok({ verifiedDomains: [], owners: 1, ownersWithMfa: '1' })],
  ])('is null (fail closed) on %s', async (_label, res) => {
    get.mockResolvedValue(res);
    await expect(httpPlatformReads.eligibility('org-1')).resolves.toBeNull();
  });

  it('is null when platform is unreachable', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(httpPlatformReads.eligibility('org-1')).resolves.toBeNull();
  });
});

describe('approvers (decision-capable counts)', () => {
  it('passes de-duplicated exclusions and returns the three counts', async () => {
    get.mockResolvedValue(ok({ holders: 5, eligible: 3, superadmins: 1 }));
    await expect(httpPlatformReads.approvers('plugins:moderate', { orgIds: ['o1', 'o1', 'o2'], userIds: ['u1'] }))
      .resolves.toEqual({ holders: 5, eligible: 3, superadmins: 1 });
    const url = get.mock.calls[0]![0] as string;
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('permission')).toBe('plugins:moderate');
    expect(q.get('excludeOrgIds')).toBe('o1,o2');
    expect(q.get('excludeUserIds')).toBe('u1');
  });

  it('omits empty exclusions', async () => {
    get.mockResolvedValue(ok({ holders: 0, eligible: 0, superadmins: 0 }));
    await expect(httpPlatformReads.approvers('publishers:verify')).resolves.toEqual({ holders: 0, eligible: 0, superadmins: 0 });
    expect(get.mock.calls[0]![0]).toBe('/internal/ecosystem/approvers?permission=publishers%3Averify');
  });

  it.each([
    ['an error status', ok({ holders: 1, eligible: 1, superadmins: 0 }, 500)],
    ['no data', { statusCode: 200, body: {} }],
    ['a missing count', ok({ holders: 1, eligible: 1 })],
    ['a NaN count', ok({ holders: Number.NaN, eligible: 1, superadmins: 0 })],
  ])('is null ("unknown", never a false shortage) on %s', async (_label, res) => {
    get.mockResolvedValue(res);
    await expect(httpPlatformReads.approvers('plugins:moderate')).resolves.toBeNull();
  });

  it('is null when platform is unreachable', async () => {
    get.mockRejectedValue(new Error('timeout'));
    await expect(httpPlatformReads.approvers('plugins:moderate', {})).resolves.toBeNull();
  });
});

describe('the test seam', () => {
  it('swaps the reads in and restores the live ones', () => {
    const fake = { eligibility: async () => null, approvers: async () => null };
    expect(platformReads()).toBe(httpPlatformReads);
    setPlatformReadsForTests(fake);
    expect(platformReads()).toBe(fake);
    setPlatformReadsForTests();
    expect(platformReads()).toBe(httpPlatformReads);
  });
});
