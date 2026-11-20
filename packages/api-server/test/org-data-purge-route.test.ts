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

  it('acks a purge that skipped tables this database does not have, naming them (not a failure)', async () => {
    mockPurge.mockResolvedValue({
      orgId: 'org-1',
      owner: 'pipeline',
      tables: { pipelines: { ok: true, rowCount: 2 }, pipeline_runners: { ok: true, rowCount: 0, absent: true } },
      failed: [],
      absent: ['pipeline_runners'],
    });
    await handleOrgDataPurge(req('org-1'), res, opts);
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { orgId: 'org-1', tables: { pipelines: 2, pipeline_runners: 0 }, absent: ['pipeline_runners'] });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      details: { owner: 'pipeline', tables: { pipelines: 2, pipeline_runners: 0 }, absent: ['pipeline_runners'] },
    }));
    expect(mockRecordAudit.mock.calls[0]![0]).not.toHaveProperty('outcome', 'failure');
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

  it('never audits a failed query\'s SQL or bound params (real tenant data)', async () => {
    const err = new Error('Failed query: delete from "pipelines" where "org_id" = $1\nparams: org-1,alice@example.com');
    err.name = 'DrizzleQueryError';
    mockPurge.mockRejectedValue(err);
    await handleOrgDataPurge(req('org-1'), res, opts);
    const details = (mockRecordAudit.mock.calls[0]![0] as { details: { error: string } }).details;
    expect(details.error).toBe('DrizzleQueryError: database query failed');
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

describe('handleOrgDataPurge — a service\'s own `purge` callback (data outside ORG_DATA_OWNERSHIP)', () => {
  const purge = jest.fn<AnyFn>();
  const cbOpts = { contract, service: 'billing', purge, auditAction: 'org.data.purge' as never };

  beforeEach(() => { purge.mockReset(); });

  it('runs the callback (not purgeOrgData), audits the counts and acks 200 { orgId, tables }', async () => {
    purge.mockResolvedValue({ tables: { subscriptions: 1, billingEvents: 3 } });
    await handleOrgDataPurge(req('org-1'), res, cbOpts);
    expect(purge).toHaveBeenCalledWith('org-1');
    expect(mockPurge).not.toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { orgId: 'org-1', tables: { subscriptions: 1, billingEvents: 3 } });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'org.data.purge',
      affectedOrgId: 'org-1',
      targetId: 'org-1',
      details: { owner: 'billing', tables: { subscriptions: 1, billingEvents: 3 } },
    }));
    expect(mockRecordAudit.mock.calls[0][0]).not.toHaveProperty('outcome');
  });

  it('answers 500 (not an ack) with the failed list when the callback reports failed tables', async () => {
    purge.mockResolvedValue({ tables: { a: 2 }, failed: ['b', 'c'] });
    await handleOrgDataPurge(req('org-1'), res, cbOpts);
    expect(mockSendSuccess).not.toHaveBeenCalled();
    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Org data purge incomplete: b, c', expect.anything());
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', details: { owner: 'billing', failed: ['b', 'c'], tables: { a: 2 } },
    }));
  });

  it('answers 500 naming the service when the callback throws', async () => {
    purge.mockRejectedValue(new Error('mongo down'));
    await handleOrgDataPurge(req('org-1'), res, cbOpts);
    expect(mockSendSuccess).not.toHaveBeenCalled();
    expect(mockSendError).toHaveBeenCalledWith(res, 500, 'Org billing purge failed', expect.anything());
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', details: { owner: 'billing', error: 'mongo down' },
    }));
  });

  it('passes an empty `remaining` through on a complete purge (a success row)', async () => {
    purge.mockResolvedValue({ tables: { subscriptions: 1 }, remaining: {} });
    await handleOrgDataPurge(req('org-1'), res, cbOpts);
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, { orgId: 'org-1', tables: { subscriptions: 1 }, remaining: {} });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { owner: 'billing', tables: { subscriptions: 1 } } }));
    expect(mockRecordAudit.mock.calls[0][0]).not.toHaveProperty('outcome');
  });

  it('a non-zero `remaining` is still a 200 carrying it (the caller\'s hook reads it as not acked), audited as a failure', async () => {
    purge.mockResolvedValue({ tables: { subscriptions: 1 }, remaining: { subscriptions: 2 } });
    await handleOrgDataPurge(req('org-1'), res, cbOpts);
    expect(mockSendError).not.toHaveBeenCalled();
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, {
      orgId: 'org-1', tables: { subscriptions: 1 }, remaining: { subscriptions: 2 },
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failure', details: { owner: 'billing', tables: { subscriptions: 1 }, remaining: { subscriptions: 2 } },
    }));
  });

  it('400s a missing orgId without calling the callback', async () => {
    await handleOrgDataPurge(req(''), res, cbOpts);
    expect(mockSendBadRequest).toHaveBeenCalledWith(res, 'orgId is required', expect.anything());
    expect(purge).not.toHaveBeenCalled();
  });

  it('still acks when the audit recorder throws', async () => {
    purge.mockResolvedValue({ tables: { organizations: 1 } });
    mockRecordAudit.mockImplementation(() => { throw new Error('audit sink down'); });
    await handleOrgDataPurge(req('org-1'), res, cbOpts);
    expect(mockSendSuccess).toHaveBeenCalledWith(res, 200, expect.anything());
    expect(mockSendError).not.toHaveBeenCalled();
  });
});
