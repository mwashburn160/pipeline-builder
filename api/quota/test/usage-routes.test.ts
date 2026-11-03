// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The usage-attribution + notice routes: `GET /:orgId/usage` (grouped ledger
 * reads + CSV), the internal unpooled `GET /:orgId/own-usage`, and the
 * account's threshold-notice settings. The REAL `authorizeOrg` runs, so the
 * tenancy guard (own org only) is exercised; the ledger and models are spies.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const queryUsage = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/usage-ledger.js', () => ({
  queryUsage,
  // Read by ai-controls (imported for its cache invalidation), never here.
  aiTokensSince: jest.fn<AnyFn>(),
  aiCallsByPrincipalSince: jest.fn<AnyFn>(),
  usageToCsv: (groupBy: string, groups: Array<{ key: string }>) => `${groupBy}\n${groups.map((g) => g.key).join('\n')}`,
}));

const findOwnByOrgId = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/services/quota-service.js', () => ({
  quotaService: { findOwnByOrgId },
}));

const settingsFindOne = jest.fn<AnyFn>();
const settingsFindOneAndUpdate = jest.fn<AnyFn>();
jest.unstable_mockModule('../src/models/quota-notice.js', () => ({
  QuotaNoticeSettings: {
    findOne: (...a: unknown[]) => ({ lean: () => settingsFindOne(...a) }),
    findOneAndUpdate: (...a: unknown[]) => ({ lean: () => settingsFindOneAndUpdate(...a) }),
  },
}));

const resolveRootOrgId = jest.fn<(id: string) => Promise<string>>();
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ resolveRootOrgId }));

jest.unstable_mockModule('../src/config.js', () => ({
  config: { quota: { resetDays: 3, usageEventRetentionDays: 90, thresholdNoticesEnabled: true } },
}));

const recordAudit = jest.fn<AnyFn>();
const assertSafeUrl = jest.fn<AnyFn>(async () => undefined);
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit,
  assertSafeUrl,
  isSystemAdmin: () => false,
  requireAuth: (_req: any, _res: any, next: any) => next(),
  getParam: (p: any, k: string) => p[k],
  sendSuccess: jest.fn((res: any, status: number, data: any) => res.status(status).json({ success: true, data })),
  sendError: jest.fn((res: any, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code })),
  sendBadRequest: jest.fn((res: any, message: string, code?: string) => res.status(400).json({ success: false, message, code })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn() }, orgId: req.params?.orgId, userId: req.user?.sub ?? '' });
  },
}));

const { createUsageRoutes } = await import('../src/routes/usage-routes.js');

function getStack(method: 'get' | 'put', path: string): Array<Function> {
  const router = createUsageRoutes();
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route?.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  return layer.route.stack.map((s: any) => s.handle);
}

async function run(method: 'get' | 'put', path: string, req: any, res: any) {
  const handlers = getStack(method, path);
  let i = 0;
  const next = async (): Promise<void> => {
    const h = handlers[i++];
    if (h) await h(req, res, next);
  };
  await next();
}

function makeRes() {
  const res: any = { status: jest.fn(), json: jest.fn(), send: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
}

const member = (orgId: string, permissions: string[] = ['quotas:read']) => ({ organizationId: orgId, sub: 'u-1', permissions });

beforeEach(() => {
  jest.clearAllMocks();
  queryUsage.mockResolvedValue([{ key: 'u-1', counted: 3, denied: 0, refunded: 0, net: 3 }]);
  resolveRootOrgId.mockImplementation(async (id) => id);
});

describe('GET /quotas/:orgId/usage', () => {
  it('defaults to the current period, grouped by principal', async () => {
    const res = makeRes();
    await run('get', '/:orgId/usage', { user: member('org-1'), params: { orgId: 'org-1' }, query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const q = queryUsage.mock.calls[0][0] as { orgId: string; groupBy: string; from: Date; to: Date; quotaType?: string };
    expect(q).toMatchObject({ orgId: 'org-1', groupBy: 'principal', quotaType: undefined });
    expect(q.to.getTime() - q.from.getTime()).toBe(3 * 86_400_000);
    const body = res.json.mock.calls[0][0].data;
    expect(body).toMatchObject({ orgId: 'org-1', groupBy: 'principal', retentionDays: 90, groups: [{ key: 'u-1' }] });
  });

  it('passes type / range / groupBy through, and downloads CSV on format=csv', async () => {
    const res = makeRes();
    await run('get', '/:orgId/usage', {
      user: member('org-1'),
      params: { orgId: 'org-1' },
      query: { type: 'automationCalls', from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', groupBy: 'pipeline', format: 'csv' },
    }, res);

    expect(queryUsage).toHaveBeenCalledWith({
      orgId: 'org-1',
      quotaType: 'automationCalls',
      groupBy: 'pipeline',
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-08T00:00:00Z'),
    });
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="quota-usage-automationCalls-by-pipeline-2026-10-01.csv"');
    expect(res.send).toHaveBeenCalledWith('pipeline\nu-1');
  });

  it('a CSV of every type is named "all"', async () => {
    const res = makeRes();
    await run('get', '/:orgId/usage', { user: member('org-1'), params: { orgId: 'org-1' }, query: { format: 'csv', to: '2026-10-08T00:00:00Z' } }, res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="quota-usage-all-by-principal-2026-10-05.csv"');
  });

  it('rejects an inverted or oversized range, and an unknown groupBy', async () => {
    for (const query of [
      { from: '2026-10-08T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      { from: '2024-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
      { groupBy: 'colour' },
    ]) {
      const res = makeRes();
      await run('get', '/:orgId/usage', { user: member('org-1'), params: { orgId: 'org-1' }, query }, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(queryUsage).not.toHaveBeenCalled();
  });

  it('refuses another tenant\'s usage at the tenancy guard', async () => {
    const res = makeRes();
    await run('get', '/:orgId/usage', { user: member('org-1'), params: { orgId: 'org-2' }, query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(queryUsage).not.toHaveBeenCalled();
  });
});

describe('GET /quotas/:orgId/own-usage (internal)', () => {
  it('serves billing the UNPOOLED own numbers', async () => {
    findOwnByOrgId.mockResolvedValue({ orgId: 'team-a', quotas: { apiCalls: { used: 4 } } });
    const res = makeRes();
    await run('get', '/:orgId/own-usage', {
      user: { organizationId: 'team-a', principalType: 'service', sub: 'service:billing' },
      params: { orgId: 'team-a' },
      query: {},
    }, res);
    expect(findOwnByOrgId).toHaveBeenCalledWith('team-a');
    expect(res.json.mock.calls[0][0].data.quota.quotas.apiCalls.used).toBe(4);
  });
});

describe('notice settings', () => {
  it('GET reads the ROOT\'s settings for a team, defaulting to enabled', async () => {
    resolveRootOrgId.mockResolvedValue('root');
    settingsFindOne.mockResolvedValue(null);
    const res = makeRes();
    await run('get', '/:orgId/notice-settings', { user: member('team-a'), params: { orgId: 'team-a' }, query: {} }, res);
    expect(settingsFindOne).toHaveBeenCalledWith({ orgId: 'root' });
    expect(res.json.mock.calls[0][0].data.settings).toMatchObject({ orgId: 'root', enabled: true, webhookUrl: null, thresholds: [80, 100] });
  });

  it('PUT on the root saves, audits without the URL, and vets the webhook', async () => {
    settingsFindOneAndUpdate.mockResolvedValue({ enabled: false, webhookUrl: 'https://hooks.example.com/q' });
    const res = makeRes();
    await run('put', '/:orgId/notice-settings', {
      user: member('root', ['billing:manage']),
      params: { orgId: 'root' },
      body: { enabled: false, webhookUrl: 'https://hooks.example.com/q' },
    }, res);

    expect(assertSafeUrl).toHaveBeenCalledWith('https://hooks.example.com/q');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'quota.notice_settings.update',
      orgId: 'root',
      details: { enabled: false, webhookConfigured: true },
    }));
  });

  it('GET returns a saved row as-is', async () => {
    settingsFindOne.mockResolvedValue({ orgId: 'root', enabled: false, webhookUrl: 'https://h.example.com' });
    const res = makeRes();
    await run('get', '/:orgId/notice-settings', { user: member('root'), params: { orgId: 'root' }, query: {} }, res);
    expect(res.json.mock.calls[0][0].data.settings).toMatchObject({ enabled: false, webhookUrl: 'https://h.example.com' });
  });

  it('PUT clearing the webhook only touches the webhook, and audits it as unconfigured', async () => {
    settingsFindOneAndUpdate.mockResolvedValue(null);
    const res = makeRes();
    await run('put', '/:orgId/notice-settings', { user: member('root', ['billing:manage']), params: { orgId: 'root' }, body: { webhookUrl: null } }, res);
    const update = settingsFindOneAndUpdate.mock.calls[0][1] as { $set: Record<string, unknown> };
    expect(update.$set).toMatchObject({ webhookUrl: null });
    expect(update.$set).not.toHaveProperty('enabled');
    expect(assertSafeUrl).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { webhookConfigured: false } }));
    expect(res.json.mock.calls[0][0].data.settings).toMatchObject({ enabled: true, webhookUrl: null });
  });

  it('PUT rejects an empty body and a non-https webhook', async () => {
    for (const body of [{}, { webhookUrl: 'http://h.example.com' }]) {
      const res = makeRes();
      await run('put', '/:orgId/notice-settings', { user: member('root', ['billing:manage']), params: { orgId: 'root' }, body }, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(settingsFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('PUT on a TEAM is refused — notices belong to the account', async () => {
    resolveRootOrgId.mockResolvedValue('root');
    const res = makeRes();
    await run('put', '/:orgId/notice-settings', { user: member('team-a', ['billing:manage']), params: { orgId: 'team-a' }, body: { enabled: false } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('PUT refuses a webhook that does not resolve to a public address', async () => {
    assertSafeUrl.mockRejectedValueOnce(new Error('private'));
    const res = makeRes();
    await run('put', '/:orgId/notice-settings', { user: member('root', ['billing:manage']), params: { orgId: 'root' }, body: { webhookUrl: 'https://10.0.0.1/x' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('PUT sets and clears the optional AI controls, audits the values, and echoes them', async () => {
    resolveRootOrgId.mockResolvedValue('root');
    settingsFindOneAndUpdate.mockResolvedValue({ enabled: true, aiCallsPerMemberPct: 25, aiTokenBudget: null });
    const res = makeRes();
    await run('put', '/:orgId/notice-settings', { user: member('root', ['billing:manage']), params: { orgId: 'root' }, body: { aiCallsPerMemberPct: 25, aiTokenBudget: null } }, res);
    const update = settingsFindOneAndUpdate.mock.calls[0][1] as { $set: Record<string, unknown> };
    expect(update.$set).toMatchObject({ aiCallsPerMemberPct: 25, aiTokenBudget: null });
    expect(update.$set).not.toHaveProperty('enabled');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'quota.notice_settings.update',
      details: { aiCallsPerMemberPct: 25, aiTokenBudget: null },
    }));
    expect(res.json.mock.calls[0][0].data.settings).toMatchObject({ aiCallsPerMemberPct: 25, aiTokenBudget: null });
  });

  it('GET reports the AI controls (null = off)', async () => {
    resolveRootOrgId.mockResolvedValue('root');
    settingsFindOne.mockResolvedValue(null);
    const res = makeRes();
    await run('get', '/:orgId/notice-settings', { user: member('root'), params: { orgId: 'root' }, query: {} }, res);
    expect(res.json.mock.calls[0][0].data.settings).toMatchObject({ aiCallsPerMemberPct: null, aiTokenBudget: null });
  });

  it('PUT rejects an out-of-range share or budget', async () => {
    resolveRootOrgId.mockResolvedValue('root');
    for (const body of [{ aiCallsPerMemberPct: 0 }, { aiCallsPerMemberPct: 101 }, { aiCallsPerMemberPct: 12.5 }, { aiTokenBudget: 0 }]) {
      const res = makeRes();
      await run('put', '/:orgId/notice-settings', { user: member('root', ['billing:manage']), params: { orgId: 'root' }, body }, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(settingsFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('PUT without billing:manage is refused', async () => {
    const res = makeRes();
    await run('put', '/:orgId/notice-settings', { user: member('root', ['quotas:read']), params: { orgId: 'root' }, body: { enabled: false } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(settingsFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
