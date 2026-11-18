// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared body of every owning service's org-purge cascade leg: the ANSWER
 * is platform's outbox ack, so it must be 2xx exactly when every table of the
 * service's slice went, and a non-2xx otherwise — never a throw, and never a
 * 500 for a purge that succeeded just because its audit row could not be
 * written.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRecordAudit = jest.fn<AnyFn>();
const mockSendSuccess = jest.fn<AnyFn>();
const mockSendError = jest.fn<AnyFn>();
const mockSendBadRequest = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  sendSuccess: (...a: unknown[]) => mockSendSuccess(...a),
  sendError: (...a: unknown[]) => mockSendError(...a),
  sendBadRequest: (...a: unknown[]) => mockSendBadRequest(...a),
}));
const mockPurge = jest.fn<AnyFn>();
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  purgeOrgData: (...a: unknown[]) => mockPurge(...a),
  purgeRowCounts: (r: { tables: Record<string, { ok: boolean; rowCount?: number }> }) => Object.fromEntries(
    Object.entries(r.tables).filter(([, t]) => t.ok).map(([n, t]) => [n, t.rowCount ?? 0]),
  ),
}));

const { handleOrgDataPurge } = await import('../src/api/org-data-purge-route.js');

// A real contract (the api-core mock passes the contracts through).
const { PIPELINE_INTERNAL } = await import('@pipeline-builder/api-core');
const contract = PIPELINE_INTERNAL.purgeOrg;
const opts = { contract, owner: 'pipeline' as const, auditAction: 'org.data.purge' as never };
const res = {} as never;
const req = (orgId?: string) => ({ params: orgId === undefined ? {} : { orgId } }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockReset();
  mockPurge.mockResolvedValue({ orgId: 'org-1', owner: 'pipeline', tables: { pipelines: { ok: true, rowCount: 2 } }, failed: [] });
});

describe('handleOrgDataPurge', () => {
  it('purges the owner\'s slice, audits the counts and acks 200 { orgId, tables }', async () => {
    await handleOrgDataPurge(req('org-1'), res, opts);
    expect(mockPurge).toHaveBeenCalledWith('pipeline', 'org-1');
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { orgId: 'org-1', tables: { pipelines: 2 } });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org.data.purge',
      affectedOrgId: 'org-1',
      targetType: 'organization',
      targetId: 'org-1',
      details: { owner: 'pipeline', tables: { pipelines: 2 } },
    }));
  });

  it('answers 500 (not an ack) when any table failed, naming it', async () => {
    mockPurge.mockResolvedValue({
      orgId: 'org-1',
      owner: 'pipeline',
      tables: { pipelines: { ok: true, rowCount: 2 }, pipeline_registry: { ok: false, error: 'boom' } },
      failed: ['pipeline_registry'],
    });
    await handleOrgDataPurge(req('org-1'), res, opts);
    expect(mockSendSuccess).not.toHaveBeenCalled();
    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Org data purge incomplete: pipeline_registry', expect.anything());
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', details: { owner: 'pipeline', failed: ['pipeline_registry'], tables: { pipelines: 2 } },
    }));
  });

  it('answers 500 when the purge throws', async () => {
    mockPurge.mockRejectedValue(new Error('pool exhausted'));
    await handleOrgDataPurge(req('org-1'), res, opts);
    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Org data purge failed', expect.anything());
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', details: { owner: 'pipeline', error: 'pool exhausted' } }));
  });

  it('400s a missing orgId without purging anything', async () => {
    await handleOrgDataPurge(req(''), res, opts);
    expect(mockSendBadRequest).toHaveBeenCalledWith(res, 'orgId is required', expect.anything());
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('still acks a successful purge whose audit row cannot be written', async () => {
    mockRecordAudit.mockImplementation(() => { throw new Error('audit not initialised'); });
    await handleOrgDataPurge(req('org-1'), res, opts);
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.anything());
    expect(mockSendError).not.toHaveBeenCalled();
  });
});
