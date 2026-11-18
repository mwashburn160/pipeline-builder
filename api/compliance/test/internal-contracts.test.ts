// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints compliance SERVES (api-core
 * `COMPLIANCE_INTERNAL`): each is mounted at its contract's method + path with the
 * contract's callers, and a sample request/response round-trips its schemas.
 * The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { COMPLIANCE_INTERNAL, buildRouteTable, internalContractsServedBy, type RouteTableEntry } from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';

const SAMPLES: Record<keyof typeof COMPLIANCE_INTERNAL, ContractSample> = {
  purgeOrg: { params: { orgId: 'org-1' }, response: { orgId: 'org-1', tables: { compliance_rules: 2 } } },
  entityEvent: {
    body: { entityId: 'p-1', orgId: 'org-1', target: 'pipeline', eventType: 'updated', userId: 'u-1', attributes: { name: 'x' }, timestamp: '2026-11-17T00:00:00.000Z' },
    response: { evaluated: true, blocked: false, violations: 0, warnings: 1 },
  },
  autoSubscribe: { body: {}, response: { subscribed: 12 } },
  syncEntitlements: {
    params: { orgId: 'org-1' },
    body: { sets: ['standard'], occurredAt: '2026-11-17T00:00:00.000Z' },
    response: { ok: true, activated: 3, deactivated: 0 },
  },
  readEntitlements: { params: { orgId: 'org-1' }, response: { sets: ['standard', 'advanced'] } },
  posture: {
    response: {
      activeRules: 48,
      activeExemptions: 3,
      frameworks: ['PCI DSS', 'SOC 2'],
      lastScan: { at: '2026-09-20T00:00:00.000Z', entities: 210, passed: 205, warnings: 2, blocked: 3 },
    },
  },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  const { app } = createApp({ enableOpenApi: false });
  mountRoutes(app, { quotaService: createQuotaService() });
  table = buildRouteTable(app);
});

describe('compliance internal endpoint contracts', () => {
  it('has a sample for every contract compliance serves', () => {
    expect(internalContractsServedBy('compliance').map((c) => c.id).sort())
      .toEqual(Object.values(COMPLIANCE_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(COMPLIANCE_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    expect(() => roundTripContractSample(contract, SAMPLES[name as keyof typeof COMPLIANCE_INTERNAL])).not.toThrow();
  });

  it('refuses a purge with no org id (the route answers 400, never a purge of everything)', () => {
    expect(COMPLIANCE_INTERNAL.purgeOrg.params.safeParse({ orgId: '' }).success).toBe(false);
  });

  it('passes an entity event\'s extra keys (its timestamp) through, and refuses one with no org', () => {
    const C = COMPLIANCE_INTERNAL.entityEvent;
    const at = new Date(0);
    const parsed = C.body!.parse({ entityId: 'e', orgId: 'o', target: 'plugin', eventType: 'created', timestamp: at });
    expect(parsed.timestamp).toBe(at);
    expect(C.body!.safeParse({ entityId: 'e', orgId: '', target: 'plugin', eventType: 'created' }).success).toBe(false);
  });

  it('reads the entitlement org canonically and names a blank one', () => {
    const C = COMPLIANCE_INTERNAL.syncEntitlements;
    expect(C.params.parse({ orgId: ' Org-1 ' })).toEqual({ orgId: 'org-1' });
    const blank = C.params.safeParse({ orgId: '  ' });
    expect(blank.success ? '' : blank.error.issues[0]!.message).toBe('orgId path parameter is required');
    expect(C.body!.safeParse({ sets: Array.from({ length: 17 }, () => 'x') }).success).toBe(false);
    expect(C.body!.safeParse({ sets: [], occurredAt: 'yesterday' }).success).toBe(false);
    expect(C.response.parse({ ok: true, skipped: true })).toEqual({ ok: true, skipped: true });
  });

  it('reads posture counts leniently, so one odd field cannot blank the panel', () => {
    const C = COMPLIANCE_INTERNAL.posture;
    expect(C.response.parse({ activeRules: '4', activeExemptions: -1, frameworks: ['SOC 2', 7], lastScan: { entities: 1 } }))
      .toEqual({ activeRules: 4, activeExemptions: 0, frameworks: ['SOC 2'], lastScan: null });
    // A reply with no data at all is NOT an empty posture: the caller reads it as unavailable.
    expect(C.response.safeParse(undefined).success).toBe(false);
  });
});
