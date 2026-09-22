// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parent-propagated (`propagateToChildren`) rules inside a TEAM:
 *  - GET /subscriptions/enforced AND the paginated GET /rules both mark them
 *    `inherited` with `sourceOrgId` and, when resolvable, `sourceOrgName` — the
 *    list used to resolve no name, which is why the UI printed a raw org UUID;
 *  - GET /rules widens the read to the parent so its binding rules are visible
 *    in the team's rule list at all;
 *  - PUT/DELETE /rules/:id from the team answers a clear 403 instead of a bare
 *    404, and never mutates or audits.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const updateMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const deleteMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const isInheritedRuleMock = jest.fn<(...a: unknown[]) => Promise<boolean>>();
const findAllEnforcedMock = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();
const findPaginatedMock = jest.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>();
const resolveOrgNameMock = jest.fn<(id: string) => Promise<string | undefined>>();
const recordAuditMock = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  recordAudit: (...a: unknown[]) => recordAuditMock(...a),
  getParam: (p: any, k: string) => p[k],
  isSystemAdmin: () => false,
  validateBody: (req: any) => ({ ok: true, value: req.body }),
  sendBadRequest: jest.fn((res: any, msg: string) => res.status(400).json({ message: msg })),
  sendError: jest.fn((res: any, status: number, msg: string, code: string) =>
    res.status(status).json({ message: msg, code })),
  sendEntityNotFound: jest.fn((res: any, what: string) => res.status(404).json({ message: what })),
  sendSuccess: jest.fn((res: any, status: number, data: any) =>
    res.status(status).json({ success: true, statusCode: status, data })),
  sendPaginatedNested: jest.fn((res: any, key: string, items: unknown[], pagination: any) =>
    res.status(200).json({ success: true, statusCode: 200, data: { [key]: items, pagination } })),
}));

jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  incCounter: () => undefined,
  withRoute: (h: Function) => async (req: any, res: any) => {
    await h({ req, res, ctx: { log: jest.fn<AnyFn>() }, orgId: req.__orgId, userId: req.user?.sub });
  },
}));


jest.unstable_mockModule('../src/helpers/org-hierarchy-client.js', () => ({
  resolveOrgName: (id: string) => resolveOrgNameMock(id),
  resolveParentOrgId: jest.fn<AnyFn>(),
}));

class InvalidRuleRegexError extends Error {}
class InvalidSetTagError extends Error {}
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: {
    update: (...a: unknown[]) => updateMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
    isInheritedRule: (...a: unknown[]) => isInheritedRuleMock(...a),
    findAllEnforced: (...a: unknown[]) => findAllEnforcedMock(...a),
    findPaginated: (...a: unknown[]) => findPaginatedMock(...a),
  },
  InvalidRuleRegexError,
  InvalidSetTagError,
}));

const { createUpdateRuleRoutes } = await import('../src/routes/update-rules.js');
const { createDeleteRuleRoutes } = await import('../src/routes/delete-rules.js');
const { INHERITED_RULE_MESSAGE } = await import('../src/helpers/inherited-rule-guard.js');

function lastHandler(router: any, path: string, method: string) {
  const layer = (router.stack as any[]).find((l) => l.route?.path === path && l.route?.methods?.[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function makeRes() {
  const json = jest.fn<AnyFn>();
  const status = jest.fn<AnyFn>().mockReturnValue({ json });
  return { res: { status, json } as any, status, json };
}

const RULE_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_USER = { sub: 'u-1', organizationId: 'team-1', parentOrganizationId: 'root-1' };
const ROOT_USER = { sub: 'u-2', organizationId: 'root-1' };

beforeEach(() => { jest.clearAllMocks(); });

describe.each([
  ['PUT', () => lastHandler(createUpdateRuleRoutes(), '/:id', 'put'), updateMock],
  ['DELETE', () => lastHandler(createDeleteRuleRoutes(), '/:id', 'delete'), deleteMock],
] as const)('%s /rules/:id on a parent-propagated rule', (_m, getHandler, mutate) => {
  it('team caller → 403 with a clear reason, no audit', async () => {
    mutate.mockResolvedValueOnce(null); // not in the team's own org
    isInheritedRuleMock.mockResolvedValueOnce(true);
    const { res, status, json } = makeRes();

    await getHandler()({ __orgId: 'team-1', params: { id: RULE_ID }, body: { name: 'x' }, user: TEAM_USER } as any, res);

    expect(isInheritedRuleMock).toHaveBeenCalledWith(RULE_ID, 'root-1');
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ message: INHERITED_RULE_MESSAGE, code: 'INSUFFICIENT_PERMISSIONS' });
    expect(recordAuditMock).not.toHaveBeenCalled();
  });

  it('team caller, rule not the parent\'s either → plain 404', async () => {
    mutate.mockResolvedValueOnce(null);
    isInheritedRuleMock.mockResolvedValueOnce(false);
    const { res, status } = makeRes();

    await getHandler()({ __orgId: 'team-1', params: { id: RULE_ID }, body: { name: 'x' }, user: TEAM_USER } as any, res);

    expect(status).toHaveBeenCalledWith(404);
  });

  it('root caller (no parent) → 404 without the inherited lookup', async () => {
    mutate.mockResolvedValueOnce(null);
    const { res, status } = makeRes();

    await getHandler()({ __orgId: 'root-1', params: { id: RULE_ID }, body: { name: 'x' }, user: ROOT_USER } as any, res);

    expect(isInheritedRuleMock).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(404);
  });
});

describe('GET /subscriptions/enforced — inherited origin', () => {
  async function getEnforced(user: Record<string, unknown>, orgId: string) {
    const { createSubscriptionRoutes } = await import('../src/routes/subscriptions.js') as any;
    const handler = lastHandler(createSubscriptionRoutes(), '/enforced', 'get');
    const { res, json } = makeRes();
    await handler({ __orgId: orgId, query: {}, user } as any, res);
    return json.mock.calls[0][0].data;
  }

  it('adds the parent name to inherited rules only', async () => {
    findAllEnforcedMock.mockResolvedValueOnce([
      { id: 'own', orgId: 'team-1', scope: 'org' },
      { id: 'inh', orgId: 'root-1', scope: 'org', inherited: true, sourceOrgId: 'root-1' },
    ]);
    resolveOrgNameMock.mockResolvedValueOnce('Acme');

    const data = await getEnforced(TEAM_USER, 'team-1');

    expect(findAllEnforcedMock).toHaveBeenCalledWith('team-1', undefined, 'root-1');
    expect(data.rules).toEqual([
      { id: 'own', orgId: 'team-1', scope: 'org' },
      { id: 'inh', orgId: 'root-1', scope: 'org', inherited: true, sourceOrgId: 'root-1', sourceOrgName: 'Acme' },
    ]);
  });

  it('skips the name lookup when nothing is inherited', async () => {
    findAllEnforcedMock.mockResolvedValueOnce([{ id: 'own', orgId: 'root-1', scope: 'org' }]);

    const data = await getEnforced(ROOT_USER, 'root-1');

    expect(resolveOrgNameMock).not.toHaveBeenCalled();
    expect(data.rules).toHaveLength(1);
  });

  it('leaves inherited rules unnamed (id only) when the lookup yields nothing', async () => {
    findAllEnforcedMock.mockResolvedValueOnce([{ id: 'inh', orgId: 'root-1', inherited: true, sourceOrgId: 'root-1' }]);
    resolveOrgNameMock.mockResolvedValueOnce(undefined);

    const data = await getEnforced(TEAM_USER, 'team-1');

    expect(data.rules[0]).not.toHaveProperty('sourceOrgName');
    expect(data.rules[0]).toMatchObject({ inherited: true, sourceOrgId: 'root-1' });
  });
});

describe('GET /rules — inherited origin on the paginated list', () => {
  async function listRules(user: Record<string, unknown>, orgId: string) {
    const { createReadRuleRoutes } = await import('../src/routes/read-rules.js') as any;
    const handler = lastHandler(createReadRuleRoutes(), '/', 'get');
    const { res, json } = makeRes();
    await handler({ __orgId: orgId, query: {}, user } as any, res);
    return json.mock.calls[0][0].data;
  }

  it('widens the read to the parent and labels its rules with the parent NAME', async () => {
    findPaginatedMock.mockResolvedValueOnce({
      data: [
        { id: 'own', orgId: 'team-1', scope: 'org' },
        { id: 'inh', orgId: 'root-1', scope: 'org' },
      ],
      total: 2,
      limit: 20,
      offset: 0,
      hasMore: false,
    });
    resolveOrgNameMock.mockResolvedValueOnce('Acme');

    const data = await listRules(TEAM_USER, 'team-1');

    // The parent org id is threaded into the query so its propagated rules are
    // visible at all — without it the team's list simply omitted them.
    expect(findPaginatedMock).toHaveBeenCalledWith(
      expect.anything(), 'team-1', expect.anything(), 'root-1',
    );
    expect(data.rules).toEqual([
      { id: 'own', orgId: 'team-1', scope: 'org' },
      { id: 'inh', orgId: 'root-1', scope: 'org', inherited: true, sourceOrgId: 'root-1', sourceOrgName: 'Acme' },
    ]);
  });

  it('leaves the name unset (never invents one) when the lookup yields nothing', async () => {
    findPaginatedMock.mockResolvedValueOnce({
      data: [{ id: 'inh', orgId: 'root-1', scope: 'org' }], total: 1, limit: 20, offset: 0, hasMore: false,
    });
    resolveOrgNameMock.mockResolvedValueOnce(undefined);

    const data = await listRules(TEAM_USER, 'team-1');

    expect(data.rules[0]).not.toHaveProperty('sourceOrgName');
    expect(data.rules[0]).toMatchObject({ inherited: true, sourceOrgId: 'root-1' });
  });

  it('a root org widens nothing and never looks a name up', async () => {
    findPaginatedMock.mockResolvedValueOnce({
      data: [{ id: 'own', orgId: 'root-1', scope: 'org' }], total: 1, limit: 20, offset: 0, hasMore: false,
    });

    const data = await listRules(ROOT_USER, 'root-1');

    expect(findPaginatedMock).toHaveBeenCalledWith(
      expect.anything(), 'root-1', expect.anything(), undefined,
    );
    expect(resolveOrgNameMock).not.toHaveBeenCalled();
    expect(data.rules[0]).not.toHaveProperty('inherited');
  });
});
