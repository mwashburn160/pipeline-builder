// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET`/`PATCH /organization/:id/setup-guide` — the per-org "setup guide"
 * dismissal flag the dashboard reads to decide whether to offer org admins the
 * one-time "finish setting up your org" guide.
 *
 * The controller AND its service run for real; only the Organization model is
 * an in-memory fake, so the idempotent-dismiss filter (`{ field: null }` matches
 * an absent field) is exercised rather than assumed.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

type Doc = Record<string, unknown> & { _id: string };
const orgs = new Map<string, Doc>();
const mockAudit = jest.fn<AnyFn>();

/** Mongo-ish filter match: `{ field: null }` matches null OR absent. */
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => (v === null ? doc[k] == null : doc[k] === v));
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getParam: (params: Record<string, string>, key: string) => params[key],
  sendError: (res: any, status: number, msg: string) => res.status(status).json({ success: false, message: msg }),
  sendSuccess: (res: any, status: number, data: unknown) => res.status(status).json({ success: true, statusCode: status, data }),
}));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: mockAudit }));
jest.unstable_mockModule('../src/helpers/org-id.js', () => ({ toOrgId: (v: unknown) => v }));
// A caller outside the target org is refused unless the target is a team beneath
// their org; no fixture here nests one org under another caller's.
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({ isAncestorOrg: async () => false }));
// validation.js (the request schemas) pulls in config and the MFA constants.
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ auth: { passwordMinLength: 8 } }));
jest.unstable_mockModule('../src/helpers/mfa-policy.js', () => ({
  DEFAULT_MFA_GRACE_DAYS: 14, MAX_MFA_GRACE_DAYS: 90, MFA_RESET_GRACE_MAX_HOURS: 168,
}));
jest.unstable_mockModule('../src/models/index.js', () => ({
  Organization: {
    findById: (id: string) => ({ select: () => ({ lean: async () => (orgs.has(id) ? { ...orgs.get(id)! } : null) }) }),
    updateOne: async (filter: Record<string, unknown>, update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> }) => {
      const { _id, ...rest } = filter;
      const doc = orgs.get(_id as string);
      if (!doc || !matches(doc, rest)) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, update.$set ?? {});
      for (const k of Object.keys(update.$unset ?? {})) delete doc[k];
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));

const { getSetupGuide, updateSetupGuide } = await import('../src/controllers/org-setup-guide.js');

const ADMIN_ID = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_ADMIN_ID = '64b7f0c2a1b2c3d4e5f60799';
const ORG_ADMIN = { sub: ADMIN_ID, organizationId: 'org1', role: 'admin' };

function makeRes() {
  const r: any = { _status: 0, _body: undefined };
  r.status = (s: number) => { r._status = s; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}

async function get(id = 'org1', user: unknown = ORG_ADMIN) {
  const res = makeRes();
  await getSetupGuide({ user, params: { id } } as any, res);
  return res;
}

async function patch(body: unknown, id = 'org1', user: unknown = ORG_ADMIN) {
  const res = makeRes();
  await updateSetupGuide({ user, params: { id }, body } as any, res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  orgs.clear();
  orgs.set('org1', { _id: 'org1', name: 'Acme', parentOrgId: null });
  orgs.set('team1', { _id: 'team1', name: 'Acme / Web', parentOrgId: 'org1' });
});

describe('GET /organization/:id/setup-guide', () => {
  it('defaults to not dismissed for a top-level org', async () => {
    const res = await get();
    expect(res._status).toBe(200);
    expect(res._body.data).toEqual({ dismissedAt: null, dismissedBy: null, topLevel: true });
  });

  it('reports topLevel false for a team (parentOrgId set)', async () => {
    const res = await get('team1', { ...ORG_ADMIN, organizationId: 'team1' });
    expect(res._status).toBe(200);
    expect(res._body.data.topLevel).toBe(false);
  });

  it('404s a missing org', async () => {
    const res = await get('gone', { ...ORG_ADMIN, organizationId: 'gone' });
    expect(res._status).toBe(404);
  });

  it('refuses an admin of another org with 403', async () => {
    const res = await get('org1', { sub: OTHER_ADMIN_ID, organizationId: 'org-other', role: 'admin' });
    expect(res._status).toBe(403);
  });

  it('refuses an anonymous caller with 401', async () => {
    expect((await get('org1', null))._status).toBe(401);
  });
});

describe('PATCH /organization/:id/setup-guide', () => {
  it('dismissing stamps when and by whom, and audits the transition', async () => {
    const res = await patch({ dismissed: true });
    expect(res._status).toBe(200);
    expect(res._body.data).toEqual({ dismissedAt: expect.any(String), dismissedBy: ADMIN_ID, topLevel: true });
    expect(Number.isNaN(Date.parse(res._body.data.dismissedAt))).toBe(false);
    expect((await get())._body.data).toEqual(res._body.data);
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.setup_guide.update', expect.objectContaining({
      targetType: 'organization',
      targetId: 'org1',
      affectedOrgId: 'org1',
      details: { dismissed: { from: false, to: true } },
    }));
  });

  it('dismissing again keeps the FIRST timestamp and actor', async () => {
    const first = (await patch({ dismissed: true }))._body.data;
    await new Promise((r) => setTimeout(r, 5));
    const second = await patch({ dismissed: true }, 'org1', { sub: OTHER_ADMIN_ID, organizationId: 'org1', role: 'admin' });
    expect(second._status).toBe(200);
    expect(second._body.data).toEqual(first);
    expect(mockAudit).toHaveBeenLastCalledWith(expect.anything(), 'org.setup_guide.update', expect.objectContaining({
      details: { dismissed: { from: true, to: true } },
    }));
  });

  it('{ dismissed: false } clears both fields so the guide is offered again', async () => {
    await patch({ dismissed: true });
    const res = await patch({ dismissed: false });
    expect(res._status).toBe(200);
    expect(res._body.data).toEqual({ dismissedAt: null, dismissedBy: null, topLevel: true });
    expect(orgs.get('org1')).not.toHaveProperty('setupGuideDismissedAt');
    expect(orgs.get('org1')).not.toHaveProperty('setupGuideDismissedBy');
    expect(mockAudit).toHaveBeenLastCalledWith(expect.anything(), 'org.setup_guide.update', expect.objectContaining({
      details: { dismissed: { from: true, to: false } },
    }));
  });

  it('refuses an admin of another org with 403 and writes nothing', async () => {
    const res = await patch({ dismissed: true }, 'org1', { sub: OTHER_ADMIN_ID, organizationId: 'org-other', role: 'admin' });
    expect(res._status).toBe(403);
    expect(orgs.get('org1')!.setupGuideDismissedAt).toBeUndefined();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('404s a missing org', async () => {
    const res = await patch({ dismissed: true }, 'gone', { ...ORG_ADMIN, organizationId: 'gone' });
    expect(res._status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty body', {}],
    ['a non-boolean', { dismissed: 'yes' }],
    ['an unknown field (strict)', { dismissed: true, extra: 1 }],
  ])('400s %s', async (_label, body) => {
    const res = await patch(body);
    expect(res._status).toBe(400);
    expect(orgs.get('org1')!.setupGuideDismissedAt).toBeUndefined();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('works on a team, which stays topLevel false', async () => {
    const res = await patch({ dismissed: true }, 'team1', { ...ORG_ADMIN, organizationId: 'team1' });
    expect(res._status).toBe(200);
    expect(res._body.data).toMatchObject({ dismissedBy: ADMIN_ID, topLevel: false });
  });
});
