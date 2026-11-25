// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Optimistic concurrency on PUT /pipelines/:id and PUT /pipeline-templates/:id.
 * The optional body `expectedUpdatedAt` (the `updatedAt` the editor loaded) is
 * validated by the route's REAL zod schema and handed to the service, and the
 * service's ConcurrencyConflictError reaches the caller as a 412
 * PRECONDITION_FAILED through the REAL `withRoute`. Absent → last write wins.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { routeHandler } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const pipelines = { findById: jest.fn<AnyFn>(), update: jest.fn<AnyFn>(), setDefault: jest.fn<AnyFn>() };
const templates = { findById: jest.fn<AnyFn>(), findByNameInOrg: jest.fn<AnyFn>(), update: jest.fn<AnyFn>() };

// The REAL AppError family, so withRoute's AppError → HTTP mapping sees the service's error.
const realApiCore = jest.requireActual('@pipeline-builder/api-core') as Record<string, unknown>;
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  AppError: realApiCore.AppError,
  ValidationError: realApiCore.ValidationError,
  // validateBody / the schemas / sendError stay REAL.
  requireVisibilityWriteAccess: () => true,
}));
jest.unstable_mockModule('../src/services/pipeline-service.js', () => ({ pipelineService: pipelines }));
jest.unstable_mockModule('../src/services/pipeline-template-service.js', () => ({ pipelineTemplateService: templates }));
jest.unstable_mockModule('../src/helpers/pipeline-write.js', () => ({
  validatePipelineWrite: async () => ({ pluginWarnings: [] }),
  buildPipelineUpdateData: (_req: unknown, body: Record<string, unknown>) =>
    Object.fromEntries(Object.entries({ description: body.description }).filter(([, v]) => v !== undefined)),
  // `from-stored` stands for a rename alone (the helper's own suite covers when that is).
  alignPipelineUpdateIdentity: (data: Record<string, unknown>) => ({ data, fromStored: data.description === 'from-stored' }),
  auditedChanges: () => ({}),
  complianceBlockedDetails: () => ({}),
  pluginWarningsField: () => ({}),
}));
jest.unstable_mockModule('../src/helpers/pipeline-update-compliance.js', () => ({
  isComplianceRelevantUpdate: () => false,
  checkPipelineUpdateCompliance: async () => ({ status: 'ok' }),
}));
jest.unstable_mockModule('../src/helpers/plugin-contract-check.js', () => ({ recordPipelineResolution: async () => undefined }));
jest.unstable_mockModule('../src/helpers/plugin-save-check.js', () => ({ checkPipelinePlugins: async () => ({ refusals: [], warnings: [] }) }));

const { ConcurrencyConflictError } = await import('@pipeline-builder/api-core');
const { createUpdatePipelineRoutes } = await import('../src/routes/update-pipeline.js');
const { createPipelineTemplateRoutes } = await import('../src/routes/pipeline-template-routes.js');

const LOADED = '2026-11-01T10:00:00.123Z';
const CONFLICT = () => new ConcurrencyConflictError(undefined, { expectedUpdatedAt: LOADED, currentUpdatedAt: '2026-11-02T00:00:00.000Z' });

async function call(router: unknown, body: Record<string, unknown>) {
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
  await routeHandler(router, 'put', '/:id')(req, res);
  return { status: res.status.mock.calls.at(-1)?.[0] as number | undefined, body: json.mock.calls.at(-1)?.[0] };
}

beforeEach(() => {
  jest.clearAllMocks();
  pipelines.findById.mockResolvedValue({ id: 'p-1', orgId: 'org-a', pipelineName: 'p', visibility: 'org' });
  pipelines.update.mockResolvedValue({ id: 'p-1', orgId: 'org-a', pipelineName: 'p' });
  pipelines.setDefault.mockResolvedValue({ id: 'p-1', orgId: 'org-a', pipelineName: 'p', isDefault: true });
  templates.findById.mockResolvedValue({ id: 'p-1', orgId: 'org-a', name: 't', visibility: 'org', inputs: [], props: {} });
  templates.update.mockResolvedValue({ id: 'p-1', name: 't' });
});

describe('PUT /pipelines/:id', () => {
  it('passes the token to the service', async () => {
    const r = await call(createUpdatePipelineRoutes(), { description: 'd', expectedUpdatedAt: LOADED });
    expect(r.status).toBe(200);
    expect(pipelines.update).toHaveBeenCalledWith('p-1', { description: 'd' }, 'org-a', 'u-1', { expectedUpdatedAt: LOADED });
  });

  it('an update that rewrites the STORED props (a rename alone) is guarded on the row it read, without a caller token', async () => {
    pipelines.findById.mockResolvedValueOnce({ id: 'p-1', orgId: 'org-a', pipelineName: 'p', visibility: 'org', updatedAt: LOADED });
    const r = await call(createUpdatePipelineRoutes(), { description: 'from-stored' });
    expect(r.status).toBe(200);
    expect(pipelines.update).toHaveBeenCalledWith('p-1', { description: 'from-stored' }, 'org-a', 'u-1', { expectedUpdatedAt: LOADED });
  });

  it('a stale token is a 412 PRECONDITION_FAILED', async () => {
    pipelines.update.mockRejectedValueOnce(CONFLICT());
    const r = await call(createUpdatePipelineRoutes(), { description: 'd', expectedUpdatedAt: LOADED });
    expect(r.status).toBe(412);
    expect(r.body).toMatchObject({ code: 'PRECONDITION_FAILED', details: { currentUpdatedAt: '2026-11-02T00:00:00.000Z' } });
  });

  it('a malformed token is a 400 before any write', async () => {
    const r = await call(createUpdatePipelineRoutes(), { description: 'd', expectedUpdatedAt: 'not-a-date' });
    expect(r.status).toBe(400);
    expect(pipelines.update).not.toHaveBeenCalled();
  });

  it('promote-to-default checks the token FIRST (even with no other field) — a conflict never promotes', async () => {
    pipelines.update.mockRejectedValueOnce(CONFLICT());
    const r = await call(createUpdatePipelineRoutes(), { isDefault: true, expectedUpdatedAt: LOADED });
    expect(r.status).toBe(412);
    expect(pipelines.update).toHaveBeenCalledWith('p-1', {}, 'org-a', 'u-1', { expectedUpdatedAt: LOADED });
    expect(pipelines.setDefault).not.toHaveBeenCalled();
  });

  it('promote-to-default with a fresh token writes, then promotes', async () => {
    const r = await call(createUpdatePipelineRoutes(), { isDefault: true, expectedUpdatedAt: LOADED });
    expect(r.status).toBe(200);
    expect(pipelines.update.mock.invocationCallOrder[0]).toBeLessThan(pipelines.setDefault.mock.invocationCallOrder[0]!);
  });

  it('promote-to-default without a token or fields only promotes (last write wins)', async () => {
    const r = await call(createUpdatePipelineRoutes(), { isDefault: true });
    expect(r.status).toBe(200);
    expect(pipelines.update).not.toHaveBeenCalled();
    expect(pipelines.setDefault).toHaveBeenCalled();
  });
});

describe('PUT /pipeline-templates/:id', () => {
  it('passes the token to the service', async () => {
    const r = await call(createPipelineTemplateRoutes(), { description: 'd', expectedUpdatedAt: LOADED });
    expect(r.status).toBe(200);
    expect(templates.update).toHaveBeenCalledWith('p-1', { description: 'd' }, 'org-a', 'u-1', { expectedUpdatedAt: LOADED });
  });

  it('a stale token is a 412 PRECONDITION_FAILED', async () => {
    templates.update.mockRejectedValueOnce(CONFLICT());
    const r = await call(createPipelineTemplateRoutes(), { description: 'd', expectedUpdatedAt: LOADED });
    expect(r.status).toBe(412);
    expect(r.body).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('a malformed token is a 400', async () => {
    const r = await call(createPipelineTemplateRoutes(), { description: 'd', expectedUpdatedAt: 12 });
    expect(r.status).toBe(400);
    expect(templates.update).not.toHaveBeenCalled();
  });
});
