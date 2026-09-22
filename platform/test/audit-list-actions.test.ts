// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /audit?actions=` — the action-group filter behind the audit page's quick
 * filters: parsed from a comma-separated list, bounded, and handed to the
 * service as one filter (one query, real pagination).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const findEvents = jest.fn(async (..._args: unknown[]) => ({
  events: [], pagination: { total: 0, offset: 0, limit: 50, hasMore: false },
}));
jest.unstable_mockModule('../src/services/audit-service.js', () => ({ auditService: { findEvents } }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => ({
  requireAdminContext: () => ({ isSuperAdmin: true, isOrgAdmin: false }),
  requireSystemAdmin: () => true,
  withController: (_name: string, fn: (req: unknown, res: unknown) => Promise<void>) => fn,
}));
jest.unstable_mockModule('../src/helpers/audit-chain.js', () => ({ verifyAuditChain: jest.fn() }));
jest.unstable_mockModule('../src/helpers/service-tenant.js', () => ({ resolveServiceTenant: jest.fn() }));

const { listAuditEvents } = await import('../src/controllers/audit.js');

function res() {
  const r: { statusCode?: number; body?: unknown; status: (c: number) => typeof r; json: (b: unknown) => typeof r } = {
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
  };
  return r;
}

const call = async (query: Record<string, unknown>) => {
  const out = res();
  await (listAuditEvents as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { query, user: { sub: 'u1', organizationId: 'system' } }, out,
  );
  return out;
};

beforeEach(() => findEvents.mockClear());

describe('GET /audit?actions=', () => {
  it('passes a trimmed group to the service as one filter', async () => {
    const out = await call({ actions: 'plugin.listing., org.plugin-install-policy.update ,', action: 'approve' });
    expect(out.statusCode).toBe(200);
    expect(findEvents).toHaveBeenCalledTimes(1);
    expect(findEvents.mock.calls[0][0]).toMatchObject({
      actions: ['plugin.listing.', 'org.plugin-install-policy.update'],
      action: 'approve',
    });
  });

  it('omits the group when absent', async () => {
    await call({});
    expect(findEvents.mock.calls[0][0]).not.toHaveProperty('actions');
  });

  it.each([
    ['too many entries', Array.from({ length: 26 }, (_, i) => `a${i}.`).join(',')],
    ['a non-action character', 'plugin.*'],
    ['a regex', '(.*)'],
    ['an over-long entry', 'a'.repeat(101)],
  ])('refuses %s with 400 and never queries', async (_label, actions) => {
    const out = await call({ actions });
    expect(out.statusCode).toBe(400);
    expect(findEvents).not.toHaveBeenCalled();
  });
});
