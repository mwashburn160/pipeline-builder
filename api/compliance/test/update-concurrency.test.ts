// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Optimistic concurrency on PUT /compliance/rules/:id and PUT /compliance/policies/:id.
 * The body's optional `expectedUpdatedAt` (the `updatedAt` the editor loaded) is
 * validated by the route's zod schema, stripped from the column write, and handed
 * to the service; the service's ConcurrencyConflictError reaches the caller as a
 * 412 PRECONDITION_FAILED through the REAL `withRoute`. Absent → last write wins.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { routeHandler } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const ruleUpdate = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const policyUpdate = jest.fn<(...a: unknown[]) => Promise<unknown>>();

// The REAL sendError, so withRoute's AppError → HTTP mapping writes the response.
const realApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ sendError: realApiCore.sendError }));
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: { findById: async () => null, update: (...a: unknown[]) => ruleUpdate(...a) },
}));
jest.unstable_mockModule('../src/services/policy-service.js', () => ({
  compliancePolicyService: { findById: async () => null, update: (...a: unknown[]) => policyUpdate(...a) },
}));
jest.unstable_mockModule('../src/helpers/inherited-rule-guard.js', () => ({ rejectIfInheritedRule: async () => false }));

const { ConcurrencyConflictError } = await import('@pipeline-builder/api-core');
const { createUpdateRuleRoutes } = await import('../src/routes/update-rules.js');
const { createUpdatePolicyRoutes } = await import('../src/routes/update-policies.js');

const ID = '33333333-3333-4333-8333-333333333333';
const LOADED = '2026-11-01T10:00:00.123Z';

function call(router: unknown, body: Record<string, unknown>) {
  const json = jest.fn();
  const res = { headersSent: false, status: jest.fn(() => res), json, setHeader: jest.fn() } as any;
  const req = {
    params: { id: ID },
    body,
    headers: {},
    user: { sub: 'u-1', organizationId: 'org-a' },
    context: { identity: { orgId: 'org-a', userId: 'u-1' }, requestId: 'r-1', log: jest.fn() },
  } as any;
  return routeHandler(router, 'put', '/:id')(req, res).then(() => ({ status: res.status.mock.calls.at(-1)?.[0], body: json.mock.calls.at(-1)?.[0] }));
}

const routes = [
  ['rule', createUpdateRuleRoutes, ruleUpdate, { description: 'x' }],
  ['policy', createUpdatePolicyRoutes, policyUpdate, { description: 'x' }],
] as const;

beforeEach(() => { jest.clearAllMocks(); });

describe.each(routes)('PUT %s /:id — expectedUpdatedAt', (_name, factory, update, change) => {
  it('passes expectedUpdatedAt to the service and keeps it out of the column write', async () => {
    update.mockResolvedValueOnce({ id: ID, name: 'n' });
    const r = await call(factory(), { ...change, expectedUpdatedAt: LOADED });
    expect(r.status).toBe(200);
    const [, data, , , options] = update.mock.calls[0]!;
    expect(data).not.toHaveProperty('expectedUpdatedAt');
    expect(options).toEqual({ expectedUpdatedAt: LOADED });
  });

  it('absent → last write wins (no token passed)', async () => {
    update.mockResolvedValueOnce({ id: ID, name: 'n' });
    await call(factory(), { ...change });
    expect(update.mock.calls[0]![4]).toEqual({ expectedUpdatedAt: undefined });
  });

  it('a stale token is a 412 PRECONDITION_FAILED with both timestamps', async () => {
    update.mockRejectedValueOnce(new ConcurrencyConflictError(undefined, { expectedUpdatedAt: LOADED, currentUpdatedAt: '2026-11-02T00:00:00.000Z' }));
    const r = await call(factory(), { ...change, expectedUpdatedAt: LOADED });
    expect(r.status).toBe(412);
    expect(JSON.stringify(r.body)).toContain('PRECONDITION_FAILED');
    expect(JSON.stringify(r.body)).toContain('2026-11-02T00:00:00.000Z');
  });

  it('a malformed token is a 400 before the service is called', async () => {
    const r = await call(factory(), { ...change, expectedUpdatedAt: 'yesterday' });
    expect(r.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
