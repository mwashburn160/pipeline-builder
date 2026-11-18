// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints reporting SERVES (api-core
 * `REPORTING_INTERNAL`): each is mounted at its contract's method + path with the
 * contract's callers, and a sample request/response round-trips its schemas.
 * The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import { OWNER_LEFT_PAUSE_REASONS, REPORTING_INTERNAL, buildRouteTable, internalContractsServedBy, type RouteTableEntry } from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';
import { REPORT_PAUSE_REASONS } from '@pipeline-builder/pipeline-data';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';

const SAMPLES: Record<keyof typeof REPORTING_INTERNAL, ContractSample> = {
  purgeOrg: { params: { orgId: 'org-1' }, response: { orgId: 'org-1', tables: { report_runs: 2 } } },
  syncRetention: {
    params: { orgId: 'org-1' },
    body: { eventRetentionDays: 90, doraRetentionDays: -1, occurredAt: '2026-11-17T00:00:00.000Z' },
    response: { orgId: 'org-1', eventRetentionDays: 90, doraRetentionDays: -1, ok: true },
  },
  readRetention: { params: { orgId: 'org-1' }, response: { orgId: 'org-1', eventRetentionDays: 90, doraRetentionDays: null } },
  syncStakeholderEntitlement: {
    params: { orgId: 'org-1' },
    body: { entitled: false, occurredAt: '2026-11-17T00:00:00.000Z' },
    response: { ok: true, paused: 2, resumed: 0, staleOrgs: 0 },
  },
  ownerLeft: {
    params: { orgId: 'org-1', userId: 'u-1' },
    body: { reason: 'owner_inactive' },
    response: { paused: [{ id: 'def-1', name: 'Weekly delivery', cadence: 'weekly' }] },
  },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { createQuotaService }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('@pipeline-builder/api-core'),
    import('../src/app-routes.js'),
  ]);
  const { app, sseManager } = createApp({ enableOpenApi: false });
  // The ticket store's backing Redis is irrelevant to the route table.
  const executionTicketStore = { issue: async () => ({ ok: true as const, ticket: 't' }), consume: async () => null, bindOwner: async () => undefined, getOwner: async () => null, stop: () => undefined };
  mountRoutes(app, { quotaService: createQuotaService(), sseManager, executionTicketStore });
  table = buildRouteTable(app);
});

describe('reporting internal endpoint contracts', () => {
  it('has a sample for every contract reporting serves', () => {
    expect(internalContractsServedBy('reporting').map((c) => c.id).sort())
      .toEqual(Object.values(REPORTING_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(REPORTING_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    expect(() => roundTripContractSample(contract, SAMPLES[name as keyof typeof REPORTING_INTERNAL])).not.toThrow();
  });

  it('refuses a purge with no org id (the route answers 400, never a purge of everything)', () => {
    expect(REPORTING_INTERNAL.purgeOrg.params.safeParse({ orgId: '' }).success).toBe(false);
  });

  /** The first issue's own message is what the route answers with. */
  const firstMessage = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) => (r.success ? '' : r.error!.issues[0]!.message);

  it('refuses a bad retention with the route\'s own message, clamps a long one, and drops a bad occurredAt', () => {
    const body = REPORTING_INTERNAL.syncRetention.body!;
    expect(firstMessage(body.safeParse({ eventRetentionDays: 1.5, doraRetentionDays: 30 }))).toBe('eventRetentionDays must be -1 or an integer in [1, 730]');
    expect(firstMessage(body.safeParse({ eventRetentionDays: 30, doraRetentionDays: 0 }))).toBe('doraRetentionDays must be -1 or an integer in [1, 730]');
    expect(firstMessage(body.safeParse({}))).toBe('eventRetentionDays must be -1 or an integer in [1, 730]');
    expect(body.parse({ eventRetentionDays: 5000, doraRetentionDays: -1, occurredAt: 'not-a-date' }))
      .toEqual({ eventRetentionDays: 730, doraRetentionDays: -1, occurredAt: undefined });
  });

  it('refuses a stakeholder-sync push with no boolean, or with extra keys', () => {
    const body = REPORTING_INTERNAL.syncStakeholderEntitlement.body!;
    expect(firstMessage(body.safeParse({}))).toBe('must be a boolean');
    expect(firstMessage(body.safeParse({ entitled: true, occurredAt: 'soon' }))).toBe('must be an ISO timestamp');
    expect(body.safeParse({ entitled: true, extra: 1 }).success).toBe(false);
  });

  it('lets platform give exactly the stored pause reasons other than billing\'s `entitlement`', () => {
    expect([...OWNER_LEFT_PAUSE_REASONS].sort()).toEqual(REPORT_PAUSE_REASONS.filter((r) => r !== 'entitlement').sort());
    expect(REPORTING_INTERNAL.ownerLeft.body!.safeParse({ reason: 'entitlement' }).success).toBe(false);
  });

  it('lowercases the owner-left org and names a missing id', () => {
    const params = REPORTING_INTERNAL.ownerLeft.params;
    expect(params.parse({ orgId: 'ORG-1', userId: 'U-1' })).toEqual({ orgId: 'org-1', userId: 'U-1' });
    expect(firstMessage(params.safeParse({ orgId: 'org-1', userId: '' }))).toBe('orgId and userId are required');
  });

  it('keeps only the paused entries shaped like a report', () => {
    expect(REPORTING_INTERNAL.ownerLeft.response.parse({ paused: [{ id: 'a', name: 'A', cadence: 'weekly' }, null, { id: 'x' }, 'y'] }))
      .toEqual({ paused: [{ id: 'a', name: 'A', cadence: 'weekly' }] });
    expect(REPORTING_INTERNAL.ownerLeft.response.parse({ paused: 'not-a-list' })).toEqual({ paused: [] });
  });
});
