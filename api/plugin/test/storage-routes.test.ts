// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * routes/storage — `GET /plugins/storage` and `POST /plugins/storage/prune`.
 *
 * Every prune refusal is audited as a FAILED `plugin.version.prune` naming the
 * reason ("why can't I free this space?" is what gets asked afterwards), and
 * each refusal answers with its OWN error code — they were all
 * VALIDATION_ERROR, so a client could not tell "a pipeline still uses it" from
 * "try again later" without parsing the message.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRecordAudit = jest.fn<AnyFn>();
const mockSendError = jest.fn((r: any, status: number, message: string, code?: string) => r.status(status).json({ success: false, message, code }));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: mockRecordAudit,
  sendError: mockSendError,
  sendSuccess: (r: any, status: number, data: unknown) => r.status(status).json({ success: true, data }),
  formatQuotaAmount: (_t: string, n: number) => `${n} B`,
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (fn: Function) => async (rq: any, rs: any) =>
    fn({ req: rq, res: rs, ctx: { log: jest.fn<AnyFn>(), requestId: 'r-1' }, orgId: 'org-1', userId: 'user-1' }),
}));

const mockPruneVersion = jest.fn<(...a: any[]) => Promise<any>>();
const mockReclaimPlan = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/storage-reclaim.js', () => ({ pruneVersion: mockPruneVersion, reclaimPlan: mockReclaimPlan }));

const { createStorageRoutes } = await import('../src/routes/storage.js');

const router = createStorageRoutes();
function handler(method: 'get' | 'post', path: string) {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function res(): any {
  const r: any = {};
  r.status = jest.fn<AnyFn>().mockReturnValue(r);
  r.json = jest.fn<AnyFn>().mockReturnValue(r);
  return r;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /plugins/storage/prune', () => {
  const prune = handler('post', '/storage/prune');
  const body = { repo: 'org-org-1/trivy', tag: '1.0.0' };

  it.each([
    ['in_use', 409, 'PLUGIN_VERSION_IN_USE'],
    ['published', 409, 'PLUGIN_VERSION_FROZEN'],
    ['unknown_version', 404, 'NOT_FOUND'],
    ['registry_unavailable', 503, 'SERVICE_UNAVAILABLE'],
  ])('refusal %s → %i %s, audited as a failed prune naming the reason', async (reason, status, code) => {
    mockPruneVersion.mockResolvedValue({ pruned: false, reason });
    const r = res();
    await prune({ body }, r);

    expect(r.status).toHaveBeenCalledWith(status);
    expect(mockSendError.mock.calls[0]![3]).toBe(code);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.version.prune',
      outcome: 'failure',
      orgId: 'org-1',
      affectedOrgId: 'org-1',
      targetId: 'org-org-1/trivy:1.0.0',
      details: { repo: 'org-org-1/trivy', tag: '1.0.0', refusal: reason },
    }));
  });

  it('prunes, recording the freed bytes (they cannot be recovered afterwards)', async () => {
    mockPruneVersion.mockResolvedValue({ pruned: true, freedBytes: 2048 });
    const r = res();
    await prune({ body }, r);

    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ freedBytes: 2048, freedLabel: '2048 B' }) }));
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.version.prune', outcome: 'success', details: { repo: 'org-org-1/trivy', tag: '1.0.0', freedBytes: 2048 },
    }));
  });

  it('400s a body without repo and tag, and touches nothing', async () => {
    const r = res();
    await prune({ body: { repo: 'x' } }, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(mockPruneVersion).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});

describe('GET /plugins/storage', () => {
  const read = handler('get', '/storage');

  it('503s rather than answering an empty plan when the registry cannot be read', async () => {
    mockReclaimPlan.mockResolvedValue(null);
    const r = res();
    await read({}, r);
    expect(r.status).toHaveBeenCalledWith(503);
    expect(mockSendError.mock.calls[0]![3]).toBe('SERVICE_UNAVAILABLE');
  });

  it('labels the headline figures', async () => {
    mockReclaimPlan.mockResolvedValue({ bytes: 10, reclaimableBytes: 4, candidates: [], incomplete: false });
    const r = res();
    await read({}, r);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ usedLabel: '10 B', reclaimableLabel: '4 B' }) }));
  });
});

// T4: a removal refused because pipelines still reference the version goes on
// the trail as a FAILED plugin.delete / plugin.purge naming those pipelines.
describe('auditRemovalRefused', () => {
  it('records an in-use refusal with the referencing pipelines, then rethrows it untouched', async () => {
    const { auditRemovalRefused } = await import('../src/routes/delete-plugin.js');
    const { AppError, ErrorCode } = await import('@pipeline-builder/api-core');
    const err = new (AppError as any)(409, ErrorCode.PLUGIN_VERSION_IN_USE, 'in use', {
      reason: 'pinned', pipelineCount: 2, orgCount: 1, severity: 'warning', pipelines: [{ id: 'pl-1' }, { id: 'pl-2' }, { name: 'no-id' }],
    });
    expect(() => auditRemovalRefused(err, { action: 'plugin.purge', orgId: 'org-1', userId: 'u-1', pluginId: 'p-1', pluginName: 'trivy', version: '1.0.0' })).toThrow(err);
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.purge',
      outcome: 'failure',
      targetId: 'p-1',
      details: {
        refusal: 'PLUGIN_VERSION_IN_USE',
        reason: 'pinned',
        pluginName: 'trivy',
        version: '1.0.0',
        pipelineCount: 2,
        orgCount: 1,
        pipelineIds: ['pl-1', 'pl-2'],
        severity: 'warning',
      },
    }));
  });

  it('records nothing for any other error', async () => {
    const { auditRemovalRefused } = await import('../src/routes/delete-plugin.js');
    const boom = new Error('db down');
    expect(() => auditRemovalRefused(boom, { action: 'plugin.delete', orgId: 'org-1', pluginId: 'p-1' })).toThrow(boom);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });
});
