// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Optimistic concurrency on PUT /plugins/:id. The optional body
 * `expectedUpdatedAt` (the `updatedAt` the editor loaded) is validated by the
 * route's REAL (still strict) zod schema, kept out of the column write and the
 * audited field list, and handed to the service; the service's
 * ConcurrencyConflictError reaches the caller as a 412 PRECONDITION_FAILED
 * through the REAL `withRoute`. Absent → last write wins.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { routeHandler } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const realApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
const mockRecordAudit = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  // The REAL AppError family + sendError, so withRoute's error mapping writes the response.
  AppError: realApiCore.AppError,
  sendError: realApiCore.sendError,
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  requireVisibilityWriteAccess: () => true,
}));

const plugins = { findById: jest.fn<AnyFn>(), update: jest.fn<AnyFn>(), versionImmutability: jest.fn<AnyFn>(async () => null) };
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({ pluginService: plugins }));
jest.unstable_mockModule('../src/helpers/deprecation-notice.js', () => ({ onPluginDeprecated: jest.fn() }));
jest.unstable_mockModule('../src/services/version-withdrawal.js', () => ({ onVersionWithdrawn: async () => null }));
jest.unstable_mockModule('../src/helpers/update-compliance.js', () => ({
  checkUpdateCompliance: async () => ({ outcome: 'allowed' }),
  needsComplianceRecheck: () => false,
}));

const { ConcurrencyConflictError } = await import('@pipeline-builder/api-core');
const { createUpdatePluginRoutes } = await import('../src/routes/update-plugin.js');

const LOADED = '2026-11-01T10:00:00.123Z';

async function call(body: Record<string, unknown>) {
  const json = jest.fn();
  const res: any = { headersSent: false, status: jest.fn(() => res), json, setHeader: jest.fn() };
  const req: any = {
    params: { id: 'p-1' },
    body,
    query: {},
    headers: {},
    user: { sub: 'u-1', organizationId: 'org-a' },
    context: { identity: { orgId: 'org-a', userId: 'u-1' }, requestId: 'r-1', log: jest.fn() },
  };
  await routeHandler(createUpdatePluginRoutes(), 'put', '/:id')(req, res);
  return { status: res.status.mock.calls.at(-1)?.[0] as number | undefined, body: json.mock.calls.at(-1)?.[0] };
}

beforeEach(() => {
  jest.clearAllMocks();
  plugins.findById.mockResolvedValue({ id: 'p-1', orgId: 'org-a', name: 'my-plugin', version: '1.0.0', visibility: 'org', isActive: true, metadataSources: {} });
  plugins.update.mockResolvedValue({ id: 'p-1', orgId: 'org-a', name: 'my-plugin', version: '1.0.0', visibility: 'org' });
});

describe('PUT /plugins/:id — expectedUpdatedAt', () => {
  it('passes the token to the service beside the caller authority, never as a column or audited field', async () => {
    const r = await call({ isActive: false, expectedUpdatedAt: LOADED });
    expect(r.status).toBe(200);
    const [, data, , , options] = plugins.update.mock.calls[0]!;
    expect(data).not.toHaveProperty('expectedUpdatedAt');
    expect(options).toMatchObject({ expectedUpdatedAt: LOADED, access: expect.any(Object) });
    expect(mockRecordAudit.mock.calls[0]![0]).toMatchObject({ details: { fields: ['isActive'] } });
  });

  it('absent → last write wins', async () => {
    await call({ isActive: false });
    expect(plugins.update.mock.calls[0]![4]).toMatchObject({ expectedUpdatedAt: undefined });
  });

  it('a stale token is a 412 PRECONDITION_FAILED', async () => {
    plugins.update.mockRejectedValueOnce(new ConcurrencyConflictError(undefined, { expectedUpdatedAt: LOADED, currentUpdatedAt: '2026-11-02T00:00:00.000Z' }));
    const r = await call({ isActive: false, expectedUpdatedAt: LOADED });
    expect(r.status).toBe(412);
    expect(r.body).toMatchObject({ code: 'PRECONDITION_FAILED', details: { currentUpdatedAt: '2026-11-02T00:00:00.000Z' } });
  });

  it('a malformed token is a 400; the schema is still strict for anything else unknown', async () => {
    expect((await call({ isActive: false, expectedUpdatedAt: 'nope' })).status).toBe(400);
    expect((await call({ isActive: false, somethingElse: 1 })).status).toBe(400);
    expect(plugins.update).not.toHaveBeenCalled();
  });
});
