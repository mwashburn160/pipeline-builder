// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client contracts for the support case paging / export, the incident balance,
 * report redelivery and campaign field clearing: paths, verbs, the opaque
 * cursor sent back verbatim, and the export's truncation header read off the
 * raw response.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import type { ApiCore } from '../src/lib/api/core';
import { messagesApi } from '../src/lib/api/domains/messages';
import { billingApi } from '../src/lib/api/domains/billing';
import { stakeholderReportsApi } from '../src/lib/api/domains/stakeholder-reports';

function fakeCore(headers: Record<string, string> = {}) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const core = {
    request: jest.fn<AnyFn>((path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      return Promise.resolve({ success: true, statusCode: 200, data: {} });
    }),
    requestRaw: jest.fn<AnyFn>((path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      // jsdom has no fetch `Response`; the client reads only these two members.
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      return Promise.resolve({
        blob: async () => new Blob(['case_number\n1']),
        headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
      });
    }),
    stepUpHeader: (t?: string) => (t ? { 'X-Step-Up-Token': t } : {}),
  } as unknown as ApiCore;
  return { core, calls };
}

describe('support case lists', () => {
  it('the first page carries no query; later pages send the cursor verbatim (and a limit when given)', async () => {
    const { core, calls } = fakeCore();
    const api = messagesApi(core);
    await api.getSupportCases();
    await api.getSupportCases({ cursor: 'opaque+/=' });
    await api.getSupportQueue({ limit: 50, cursor: 'q1' });
    await api.getSupportQueue();
    expect(calls.map((c) => c.path)).toEqual([
      '/api/messages/support/cases',
      '/api/messages/support/cases?cursor=opaque%2B%2F%3D',
      '/api/messages/support/queue?limit=50&cursor=q1',
      '/api/messages/support/queue',
    ]);
  });

  it('the export is a scripted read that surfaces X-Export-Truncated', async () => {
    const truncated = fakeCore({ 'X-Export-Truncated': 'true' });
    const res = await messagesApi(truncated.core).exportSupportCases();
    expect(truncated.calls[0].path).toBe('/api/messages/support/cases/export');
    expect(res.truncated).toBe(true);
    expect(res.blob.size).toBe('case_number\n1'.length);

    const complete = fakeCore();
    expect((await messagesApi(complete.core).exportSupportCases()).truncated).toBe(false);
  });
});

describe('billing', () => {
  it('reads the account incident balance', async () => {
    const { core, calls } = fakeCore();
    await billingApi(core).getSupportIncidentBalance();
    expect(calls[0].path).toBe('/api/billing/support-incidents');
  });

  it('a campaign edit sends null to clear a field', async () => {
    const { core, calls } = fakeCore();
    await billingApi(core).updateCampaign('summer', { budgetCents: null, endsAt: null });
    expect(calls[0]).toMatchObject({ path: '/api/billing/admin/campaigns/summer', init: { method: 'PUT' } });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ budgetCents: null, endsAt: null });
  });
});

describe('stakeholder reports', () => {
  it('redelivers a run', async () => {
    const { core, calls } = fakeCore();
    await stakeholderReportsApi(core).redeliverReportRun('run/1');
    expect(calls[0]).toMatchObject({ path: '/api/reports/stakeholder/runs/run%2F1/redeliver', init: { method: 'POST' } });
  });
});
