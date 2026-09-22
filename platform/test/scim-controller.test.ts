// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SCIM HTTP layer, with the service mocked — so what is under test is
 * the contract with the identity provider, not the provisioning policy:
 *
 *   - status codes and headers: 201 + `Location` on create, 204 with no body on
 *     delete, `application/scim+json` everywhere;
 *   - the org comes from the TOKEN, never from a path or a body;
 *   - every write is audited with the attributes that moved (and never their
 *     values), every refusal is audited as a failure with its reason;
 *   - a refusal because the SSO entitlement lapsed also notifies the org's admins
 *     (the plan's "admins are notified"), and only for that reason;
 *   - an unexpected failure answers a bare SCIM 500 with no internals.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({}));

const audits: Array<{ action: string; options: Record<string, unknown> }> = [];
jest.unstable_mockModule('../src/helpers/audit.js', () => ({
  audit: (_req: unknown, action: string, options: Record<string, unknown> = {}) => { audits.push({ action, options }); },
}));

const counters: Array<{ name: string; labels: Record<string, string> }> = [];
jest.unstable_mockModule('../src/observability/metrics.js', () => ({
  incCounter: (name: string, labels: Record<string, string> = {}) => { counters.push({ name, labels }); },
}));

const notified: string[] = [];
jest.unstable_mockModule('../src/helpers/scim-entitlement-notice.js', () => ({
  notifyScimEntitlementLapsed: async (orgId: string) => { notified.push(orgId); return true; },
}));

let entitled = true;
const entitlementCalls: string[] = [];
jest.unstable_mockModule('../src/helpers/sso-enforcement.js', () => ({
  isSsoEntitled: async (orgId: string) => { entitlementCalls.push(orgId); return entitled; },
}));

const svc = {
  listUsers: jest.fn<(...a: any[]) => Promise<unknown>>(),
  getUser: jest.fn<(...a: any[]) => Promise<unknown>>(),
  createUser: jest.fn<(...a: any[]) => Promise<unknown>>(),
  replaceUser: jest.fn<(...a: any[]) => Promise<unknown>>(),
  patchUser: jest.fn<(...a: any[]) => Promise<unknown>>(),
  deleteUser: jest.fn<(...a: any[]) => Promise<unknown>>(),
  listGroups: jest.fn<(...a: any[]) => Promise<unknown>>(),
  getGroup: jest.fn<(...a: any[]) => Promise<unknown>>(),
  createGroup: jest.fn<(...a: any[]) => Promise<unknown>>(),
  replaceGroup: jest.fn<(...a: any[]) => Promise<unknown>>(),
  patchGroup: jest.fn<(...a: any[]) => Promise<unknown>>(),
  deleteGroup: jest.fn<(...a: any[]) => Promise<unknown>>(),
  serviceProviderConfig: jest.fn<() => Promise<unknown>>(async () => ({ schemas: ['cfg'] })),
  resourceTypes: jest.fn<() => Promise<unknown>>(async () => ({ schemas: ['types'] })),
  schemas: jest.fn<() => Promise<unknown>>(async () => ({ schemas: ['schemas'] })),
};
jest.unstable_mockModule('../src/services/scim-users.js', () => svc);
jest.unstable_mockModule('../src/services/scim-groups.js', () => svc);
jest.unstable_mockModule('../src/services/scim-discovery.js', () => svc);

const ctl = await import('../src/controllers/scim.js');
const { scimSeatLimit, scimNotEntitled, scimUniqueness } = await import('../src/services/scim-errors.js');

const USER_RESOURCE = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  id: 'u1',
  userName: 'alice@acme.com',
  active: true,
  meta: { resourceType: 'User', location: 'https://pb.example.com/api/scim/v2/Users/u1' },
};

function fakeReq(over: Record<string, unknown> = {}) {
  return {
    user: { organizationId: 'org1', sub: 'sa1', principalType: 'service_account', scope: 'scim' },
    params: {},
    query: {},
    body: {},
    headers: {},
    ...over,
  } as never;
}

function fakeRes() {
  const captured: { status: number; type: string; body: any; headers: Record<string, string>; ended: boolean } =
    { status: 0, type: '', body: undefined, headers: {}, ended: false };
  const res: any = {
    headersSent: false,
    status: (code: number) => { captured.status = code; return res; },
    type: (t: string) => { captured.type = t; return res; },
    setHeader: (k: string, v: string) => { captured.headers[k] = v; },
    send: (payload: string) => { captured.body = JSON.parse(payload); res.headersSent = true; return res; },
    end: () => { captured.ended = true; res.headersSent = true; return res; },
  };
  return { res, captured };
}

beforeEach(() => {
  audits.length = 0;
  counters.length = 0;
  notified.length = 0;
  entitlementCalls.length = 0;
  entitled = true;
});

describe('SCIM responses', () => {
  it('creates with 201, the SCIM media type and a Location header', async () => {
    svc.createUser.mockResolvedValue({ resource: USER_RESOURCE, action: 'create', changed: ['userName', 'active'] });
    const { res, captured } = fakeRes();
    await ctl.scimCreateUser(fakeReq({ body: { userName: 'alice@acme.com' } }), res);

    expect(captured.status).toBe(201);
    expect(captured.type).toBe('application/scim+json; charset=utf-8');
    expect(captured.headers.Location).toBe('https://pb.example.com/api/scim/v2/Users/u1');
    expect(captured.body.id).toBe('u1');
  });

  it('answers 204 with NO body on delete, as RFC 7644 §3.6 requires', async () => {
    svc.deleteUser.mockResolvedValue({ resource: { id: 'u1' }, action: 'delete', changed: ['active'] });
    const { res, captured } = fakeRes();
    await ctl.scimDeleteUser(fakeReq({ params: { id: 'u1' } }), res);

    expect(captured.status).toBe(204);
    expect(captured.ended).toBe(true);
    expect(captured.body).toBeUndefined();
  });

  it('resolves the org from the TOKEN, not from the request', async () => {
    svc.listUsers.mockResolvedValue({ schemas: [], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
    const { res } = fakeRes();
    // A body/param naming another org must not be consulted at all.
    await ctl.scimListUsers(fakeReq({ params: { id: 'other-org' }, body: { organizationId: 'other-org' } }), res);

    expect(entitlementCalls).toEqual(['org1']);
    expect(svc.listUsers).toHaveBeenCalledWith({ orgId: 'org1', entitled: true }, expect.anything());
  });

  it('passes the live entitlement into the service on EVERY request', async () => {
    entitled = false;
    svc.listUsers.mockResolvedValue({ schemas: [], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
    const { res } = fakeRes();
    await ctl.scimListUsers(fakeReq(), res);
    // Read live rather than from the key's claims — a key can live a year, and a
    // downgrade has to take effect on the next call.
    expect(svc.listUsers).toHaveBeenCalledWith({ orgId: 'org1', entitled: false }, expect.anything());
  });

  it('hands the PatchOp Operations array through under either spelling', async () => {
    svc.patchUser.mockResolvedValue({ resource: USER_RESOURCE, action: 'deactivate', changed: ['active'] });
    const { res } = fakeRes();
    const ops = [{ op: 'replace', value: { active: false } }];
    await ctl.scimPatchUser(fakeReq({ params: { id: 'u1' }, body: { Operations: ops } }), res);
    expect(svc.patchUser).toHaveBeenCalledWith(expect.anything(), 'u1', ops);
  });
});

describe('SCIM auditing', () => {
  it('records what MOVED, never the values', async () => {
    svc.patchUser.mockResolvedValue({ resource: USER_RESOURCE, action: 'deactivate', changed: ['active'] });
    const { res } = fakeRes();
    await ctl.scimPatchUser(fakeReq({ params: { id: 'u1' }, body: { Operations: [{ op: 'replace', value: { active: false } }] } }), res);

    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('org.scim.user.deactivate');
    expect(audits[0].options).toMatchObject({ targetType: 'User', targetId: 'u1', affectedOrgId: 'org1', details: { changed: ['active'] } });
    // A directory sync carries personal data; the audit row must not become a
    // second copy of it.
    expect(JSON.stringify(audits[0].options)).not.toContain('alice@acme.com');
  });

  it('names group member changes distinctly from a group rename', async () => {
    svc.patchGroup.mockResolvedValue({
      resource: { id: 'g1', meta: { location: 'x' } },
      action: 'members',
      changed: ['members'],
      affectedUserIds: ['u1', 'u2'],
    });
    const { res } = fakeRes();
    await ctl.scimPatchGroup(fakeReq({ params: { id: 'g1' }, body: { Operations: [] } }), res);
    expect(audits[0].action).toBe('org.scim.group.members');
    expect(audits[0].options.details).toMatchObject({ membersAffected: 2 });
  });

  it('audits a REFUSAL as a failure, with its reason', async () => {
    svc.createUser.mockRejectedValue(scimSeatLimit(3));
    const { res, captured } = fakeRes();
    await ctl.scimCreateUser(fakeReq({ body: { userName: 'bob@acme.com' } }), res);

    expect(captured.status).toBe(403);
    expect(captured.body.detail).toMatch(/seat limit reached/i);
    expect(audits[0].action).toBe('org.scim.refused');
    expect(audits[0].options).toMatchObject({ outcome: 'failure', details: { reason: 'seat_limit', status: 403 } });
  });

  it('carries the scimType through to the client and the audit row', async () => {
    svc.createGroup.mockRejectedValue(scimUniqueness('already exists'));
    const { res, captured } = fakeRes();
    await ctl.scimCreateGroup(fakeReq({ body: { displayName: 'Eng' } }), res);

    expect(captured.status).toBe(409);
    expect(captured.body.scimType).toBe('uniqueness');
    expect(audits[0].options.details).toMatchObject({ scimType: 'uniqueness' });
  });
});

describe('SCIM metrics', () => {
  it('counts success by resource and operation', async () => {
    svc.listGroups.mockResolvedValue({ schemas: [], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
    const { res } = fakeRes();
    await ctl.scimListGroups(fakeReq(), res);
    expect(counters).toContainEqual({ name: 'platform_scim_requests_total', labels: { resource: 'Group', operation: 'list', result: 'success' } });
  });

  it('counts an error by its reason — the plan\'s "SCIM errors by type"', async () => {
    svc.createUser.mockRejectedValue(scimSeatLimit(1));
    const { res } = fakeRes();
    await ctl.scimCreateUser(fakeReq(), res);
    expect(counters).toContainEqual({ name: 'platform_scim_errors_total', labels: { resource: 'User', operation: 'create', reason: 'seat_limit' } });
  });
});

describe('the post-downgrade notice', () => {
  it('notifies the org admins when a write is refused for the lapsed entitlement', async () => {
    svc.createUser.mockRejectedValue(scimNotEntitled());
    const { res, captured } = fakeRes();
    await ctl.scimCreateUser(fakeReq(), res);

    expect(captured.status).toBe(403);
    // The detail tells the IdP operator that removals still work.
    expect(captured.body.detail).toMatch(/deactivating and deleting users still works/i);
    expect(notified).toEqual(['org1']);
  });

  it('does NOT notify for an ordinary refusal', async () => {
    svc.createUser.mockRejectedValue(scimUniqueness('exists'));
    const { res } = fakeRes();
    await ctl.scimCreateUser(fakeReq(), res);
    expect(notified).toEqual([]);
  });
});

describe('unexpected failures', () => {
  it('answer a bare SCIM 500 with no internals', async () => {
    svc.listUsers.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:27017'));
    const { res, captured } = fakeRes();
    await ctl.scimListUsers(fakeReq(), res);

    expect(captured.status).toBe(500);
    expect(captured.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect(JSON.stringify(captured.body)).not.toContain('ECONNREFUSED');
    expect(counters).toContainEqual({ name: 'platform_scim_errors_total', labels: { resource: 'User', operation: 'list', reason: 'internal' } });
  });
});

describe('discovery endpoints', () => {
  it('serve the three documents a validator fetches first', async () => {
    for (const [handler, marker] of [
      [ctl.scimServiceProviderConfig, 'cfg'],
      [ctl.scimResourceTypes, 'types'],
      [ctl.scimSchemas, 'schemas'],
    ] as const) {
      const { res, captured } = fakeRes();
      await handler(fakeReq(), res);
      expect(captured.status).toBe(200);
      expect(captured.body.schemas).toEqual([marker]);
    }
  });
});
