// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two identity reads reporting makes against platform.
 *
 * Every test here is about the same property: THESE FAIL CLOSED. A scheduled
 * report is authorized as its owner, and the only service that knows whether that
 * person still has access is platform. If the answer cannot be trusted — platform
 * unreachable, a non-2xx, a body that is not the shape it promised — the caller
 * must get `null` and treat it as "not authorized", because the alternative is a
 * platform outage turning into reports delivered on a lapsed subscription, or org
 * data mailed to an address nobody verified.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGet = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  InternalHttpClient: class {
    get(...args: unknown[]) { return mockGet(...args); }
  },
  getServiceAuthHeader: () => 'Bearer reporting-service-token',
}));

jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { platformHost: 'platform', platformPort: 3000 } }) },
}));

const { httpReportIdentity, reportIdentity, setReportIdentity } = await import('../src/services/report-identity.js');

const ORG = 'acme';
const USER = 'user-lead';
const ok = (data: unknown) => ({ statusCode: 200, body: { data } });

describe('report identity reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setReportIdentity(httpReportIdentity);
  });

  describe('authority', () => {
    it('reads the owner’s reporting permissions and the org’s features', async () => {
      mockGet.mockResolvedValue(ok({
        active: true,
        permissions: ['reports:read', 'reports:author'],
        features: ['stakeholder_reports'],
        tier: 'team',
      }));
      expect(await httpReportIdentity.authority(ORG, USER)).toEqual({
        active: true,
        permissions: ['reports:read', 'reports:author'],
        features: ['stakeholder_reports'],
        tier: 'team',
      });
      expect(mockGet).toHaveBeenCalledWith(
        `/internal/reporting/report-authority/${ORG}/${USER}`,
        { headers: { Authorization: 'Bearer reporting-service-token' } },
      );
    });

    it('url-encodes the ids rather than pasting them into the path', async () => {
      mockGet.mockResolvedValue(ok({ active: false, permissions: [], features: [] }));
      await httpReportIdentity.authority('org/../../etc', 'user id');
      expect(mockGet.mock.calls[0][0]).toBe('/internal/reporting/report-authority/org%2F..%2F..%2Fetc/user%20id');
    });

    it('carries an inactive answer through as-is', async () => {
      mockGet.mockResolvedValue(ok({ active: false, permissions: [], features: [] }));
      expect(await httpReportIdentity.authority(ORG, USER)).toEqual({ active: false, permissions: [], features: [] });
    });

    it('omits the tier when platform did not send one', async () => {
      mockGet.mockResolvedValue(ok({ active: true, permissions: [], features: [] }));
      expect(await httpReportIdentity.authority(ORG, USER)).not.toHaveProperty('tier');
    });

    it('drops non-string entries rather than passing them on', async () => {
      mockGet.mockResolvedValue(ok({ active: true, permissions: ['reports:author', 7, null], features: 'nope' }));
      expect(await httpReportIdentity.authority(ORG, USER)).toEqual({
        active: true,
        permissions: ['reports:author'],
        features: [],
      });
    });

    it.each([
      ['the request throws', () => { mockGet.mockRejectedValue(new Error('ECONNREFUSED')); }],
      ['platform answers 500', () => { mockGet.mockResolvedValue({ statusCode: 500, body: {} }); }],
      ['platform answers 403', () => { mockGet.mockResolvedValue({ statusCode: 403, body: { data: { active: true } } }); }],
      ['the body has no data', () => { mockGet.mockResolvedValue({ statusCode: 200, body: {} }); }],
      ['`active` is not a boolean', () => { mockGet.mockResolvedValue(ok({ active: 'yes', permissions: [] })); }],
    ])('returns null when %s, so the caller fails closed', async (_case, arrange) => {
      arrange();
      expect(await httpReportIdentity.authority(ORG, USER)).toBeNull();
    });
  });

  describe('recipientCheck', () => {
    it('asks about one address and returns what platform said', async () => {
      mockGet.mockResolvedValue(ok({ member: true, userId: 'user-2', displayName: 'Dana Ng' }));
      expect(await httpReportIdentity.recipientCheck(ORG, 'dana@acme.test'))
        .toEqual({ member: true, userId: 'user-2', displayName: 'Dana Ng' });
      expect(mockGet.mock.calls[0][0]).toBe(`/internal/reporting/recipient-check/${ORG}?email=dana%40acme.test`);
    });

    it('omits the optional fields platform left out', async () => {
      mockGet.mockResolvedValue(ok({ member: false }));
      expect(await httpReportIdentity.recipientCheck(ORG, 'x@y.test')).toEqual({ member: false });
    });

    it.each([
      ['the request throws', () => { mockGet.mockRejectedValue(new Error('ETIMEDOUT')); }],
      ['platform answers 400', () => { mockGet.mockResolvedValue({ statusCode: 400, body: {} }); }],
      ['`member` is missing', () => { mockGet.mockResolvedValue(ok({ userId: 'u' })); }],
    ])('returns null when %s — never a default of "member"', async (_case, arrange) => {
      arrange();
      expect(await httpReportIdentity.recipientCheck(ORG, 'x@y.test')).toBeNull();
    });
  });

  it('uses the HTTP implementation by default, and can be swapped for a test double', () => {
    expect(reportIdentity()).toBe(httpReportIdentity);
    const stub = { authority: async () => null, recipientCheck: async () => null };
    setReportIdentity(stub);
    expect(reportIdentity()).toBe(stub);
  });
});
