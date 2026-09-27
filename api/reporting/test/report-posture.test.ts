// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The compliance + access posture read.
 *
 * One behaviour matters more than all the parsing: EACH HALF DEGRADES ON ITS OWN. A
 * weekly report that did not arrive because one optional panel's upstream was down is a
 * support ticket; a panel that says it could not be computed is information. So an
 * unreachable compliance service must leave the access half intact, and vice versa, and
 * neither may ever reject.
 *
 * The other thing pinned here is the AUTH SHAPE, because the two legs differ on purpose:
 * compliance takes the tenant from the token (so there is no path to disagree with), and
 * platform's endpoint is an explicit cross-org read called with the system-org token.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockGet = jest.fn<AnyFn>();
const mockServiceAuth = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  InternalHttpClient: class {
    get = (...a: unknown[]) => mockGet(...a);
  },
  getServiceAuthHeader: (...a: unknown[]) => {
    mockServiceAuth(...a);
    return 'Bearer service-token';
  },
}));

const { readPosture } = await import('../src/services/report-posture.js');

const FROM = '2026-09-14T00:00:00Z';
const TO = '2026-09-21T00:00:00Z';

const complianceBody = {
  statusCode: 200,
  body: {
    data: {
      activeRules: 48,
      activeExemptions: 3,
      frameworks: ['PCI DSS', 'SOC 2'],
      lastScan: { at: '2026-09-20T00:00:00Z', entities: 210, passed: 205, warnings: 2, blocked: 3 },
    },
  },
};

const accessBody = {
  statusCode: 200,
  body: {
    data: {
      members: 18,
      membersWithMfa: 14,
      ssoRequired: true,
      serviceAccounts: 2,
      activeApiKeys: 5,
      permissionChanges: 1,
    },
  },
};

/** Route each call by its path, so one leg can fail while the other succeeds. */
function routed(compliance: unknown, access: unknown): void {
  mockGet.mockImplementation((path: unknown) => {
    const p = String(path);
    const answer = p.includes('/compliance/posture') ? compliance : access;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('readPosture', () => {
  it('returns both halves when both services answer', async () => {
    routed(complianceBody, accessBody);
    const posture = await readPosture('acme', FROM, TO);
    expect(posture.compliance).toMatchObject({ activeRules: 48, activeExemptions: 3 });
    expect(posture.compliance?.lastScan).toMatchObject({ entities: 210, blocked: 3 });
    expect(posture.access).toMatchObject({ members: 18, membersWithMfa: 14, ssoRequired: true });
    expect(posture.unavailable).toBeUndefined();
  });

  it('keeps the access half when COMPLIANCE is unreachable', async () => {
    routed(new Error('ECONNREFUSED'), accessBody);
    const posture = await readPosture('acme', FROM, TO);
    expect(posture.compliance).toBeNull();
    expect(posture.access).not.toBeNull();
    expect(posture.unavailable?.join(' ')).toContain('Compliance posture could not be read');
  });

  it('keeps the compliance half when PLATFORM is unreachable', async () => {
    routed(complianceBody, new Error('ETIMEDOUT'));
    const posture = await readPosture('acme', FROM, TO);
    expect(posture.access).toBeNull();
    expect(posture.compliance).not.toBeNull();
    expect(posture.unavailable?.join(' ')).toContain('Access posture could not be read');
  });

  it('never rejects, even with both upstreams dead', async () => {
    routed(new Error('x'), new Error('y'));
    const posture = await readPosture('acme', FROM, TO);
    // The section renders "unavailable" and the rest of the report still reaches the lead.
    expect(posture).toMatchObject({ compliance: null, access: null });
    expect(posture.unavailable).toHaveLength(2);
  });

  it('treats a non-2xx as unavailable rather than as empty', async () => {
    routed({ statusCode: 500, body: {} }, accessBody);
    // An empty posture would read as "no rules", which is a claim rather than a gap.
    expect((await readPosture('acme', FROM, TO)).compliance).toBeNull();
  });

  it('treats a malformed access body as unavailable', async () => {
    routed(complianceBody, { statusCode: 200, body: { data: { members: 'lots' } } });
    expect((await readPosture('acme', FROM, TO)).access).toBeNull();
  });

  it('asks compliance with a PER-ORG token and no org in the path', async () => {
    routed(complianceBody, accessBody);
    await readPosture('acme', FROM, TO);
    const compliancePath = mockGet.mock.calls.map((c) => String(c[0])).find((p) => p.includes('compliance'));
    // The org travels in the token, so a reporting bug cannot read a second org's posture
    // by building the wrong URL.
    expect(compliancePath).toBe('/compliance/posture');
    expect(mockServiceAuth).toHaveBeenCalledWith(expect.objectContaining({ serviceName: 'reporting', orgId: 'acme' }));
  });

  it('asks platform with the org in the PATH and the window as query', async () => {
    routed(complianceBody, accessBody);
    await readPosture('acme', FROM, TO);
    const accessPath = mockGet.mock.calls.map((c) => String(c[0])).find((p) => p.includes('access-posture'));
    expect(accessPath).toContain('/internal/reporting/access-posture/acme');
    expect(accessPath).toContain(encodeURIComponent(FROM));
  });

  it('reports a never-scanned org as a null scan, not a zeroed one', async () => {
    routed({ statusCode: 200, body: { data: { activeRules: 5, activeExemptions: 0, frameworks: [] } } }, accessBody);
    const posture = await readPosture('acme', FROM, TO);
    // "Never scanned" and "scanned, nothing blocked" are different facts.
    expect(posture.compliance?.lastScan).toBeNull();
    expect(posture.compliance?.activeRules).toBe(5);
  });

  it('drops non-string framework entries rather than rendering them', async () => {
    routed({ statusCode: 200, body: { data: { activeRules: 1, frameworks: ['SOC 2', 7, null] } } }, accessBody);
    expect((await readPosture('acme', FROM, TO)).compliance?.frameworks).toEqual(['SOC 2']);
  });

  it('floors a negative or non-numeric count at zero', async () => {
    routed(complianceBody, {
      statusCode: 200,
      body: { data: { members: 18, membersWithMfa: -3, serviceAccounts: 'two', activeApiKeys: 5, permissionChanges: 0 } },
    });
    const access = (await readPosture('acme', FROM, TO)).access;
    expect(access).toMatchObject({ membersWithMfa: 0, serviceAccounts: 0 });
  });
});
