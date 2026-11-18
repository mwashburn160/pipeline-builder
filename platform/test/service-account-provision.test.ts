// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /organization/:id/service-accounts/provision-key` — the whole of
 * `pipeline-manager infra store-token`'s provisioning behind ONE step-up.
 *
 * Driven through the REAL api-core `requirePermission` and `requireStepUp` with a
 * platform-minted step-up token (in-memory signing keys), the REAL
 * controller-helper tenancy gate, and the real zod schema; only the service
 * layer (whose own rules have their own suites) and the audit sink are stubbed.
 *
 * What it pins:
 *   - a missing account is created with the org's built-in Role for `role`, an
 *     existing one is reused and its Roles are never touched, and the create
 *     race (`SA_NAME_TAKEN`) resolves by re-reading;
 *   - `scope` is stamped on the key, not the account;
 *   - at the active-key cap the OLDEST active key is retired and the mint
 *     retried once — and ONE step-up token covers create + retire + issue, while
 *     a second use of it is refused;
 *   - the audit trail is the same three actions, with the same details, as the
 *     individual routes write;
 *   - 401 without a step-up, 403 without the permission or outside the org,
 *     400 on a bad body, 409 when the org lacks the built-in Role.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { controllerHelperMock } from './helpers/controller-helper-mock.js';

process.env.JWT_SECRET ||= 'provision-key-test-secret';
process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';
for (const k of ['JWT_ISSUER', 'JWT_AUDIENCE', 'REDIS_URL', 'REDIS_SENTINELS']) delete process.env[k];

const mockAudit = jest.fn<AnyFn>();
const sa = {
  findServiceAccountByName: jest.fn<AnyFn>(),
  resolveBuiltinRoleId: jest.fn<AnyFn>(),
  createServiceAccount: jest.fn<AnyFn>(),
  createServiceAccountKey: jest.fn<AnyFn>(),
  getServiceAccount: jest.fn<AnyFn>(),
  revokeServiceAccountKey: jest.fn<AnyFn>(),
};

jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/helpers/controller-helper.js', () => controllerHelperMock());
// Tenancy: the real gate, with "is the target a team under my org?" answered no.
jest.unstable_mockModule('../src/helpers/org-hierarchy.js', () => ({
  ...(jest.requireActual('../src/helpers/org-hierarchy.js') as Record<string, unknown>),
  isAncestorOrg: async () => false,
}));
jest.unstable_mockModule('../src/services/service-account-service.js', () => ({
  ...Object.fromEntries(Object.entries(sa).map(([k, fn]) => [k, (...a: unknown[]) => fn(...a)])),
  deleteServiceAccount: jest.fn(),
  listServiceAccounts: jest.fn(),
  serviceAccountBillingSummary: jest.fn(),
  snapshotOf: jest.fn(),
  updateServiceAccount: jest.fn(),
}));

const { requirePermission, requireStepUp } = await import('@pipeline-builder/api-core');
const { issueStepUpToken } = await import('../src/services/session/access-tokens.js');
const { installTestSigningKeys } = await import('./helpers/signing.js');
const { provisionOrganizationServiceAccountKey } = await import('../src/controllers/service-accounts.js');
installTestSigningKeys();

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const USER = { sub: 'user-1', organizationId: ORG, role: 'admin', permissions: ['service_accounts:manage', 'pipelines:write'] };

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockRes() {
  const res: any = { headersSent: false };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; res.headersSent = true; return res; });
  res.setHeader = jest.fn();
  return res;
}

/** The route's own gate sequence (minus the pass-through bootstrap/aal gates,
 *  covered by step-up-route-gates + mfa-assurance), then the controller. */
async function provision(body: unknown, opts: { token?: string; user?: Record<string, unknown>; orgId?: string } = {}) {
  const req: any = {
    user: opts.user ?? USER,
    params: { id: opts.orgId ?? ORG },
    body,
    headers: { 'user-agent': 'pipeline-manager/9.9.9 (darwin)', ...(opts.token ? { 'x-step-up-token': opts.token } : {}) },
    ip: '203.0.113.7',
    method: 'POST',
    path: `/organization/${ORG}/service-accounts/provision-key`,
  };
  const res = mockRes();
  const chain = [requirePermission('service_accounts:manage'), requireStepUp, provisionOrganizationServiceAccountKey] as any[];
  for (const mw of chain) {
    let advanced = false;
    await mw(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const stepUp = async () => (await issueStepUpToken(USER.sub, 'password')).token;

const BODY = {
  accountName: 'pipeline-automation',
  description: 'Platform credential for store-token',
  role: 'pipeline_automation',
  key: { name: 'store-token 2026-11-18', expiresIn: 30 * 24 * 3600 },
};

const account = (over: Record<string, unknown> = {}) => ({
  id: 'sa-1', name: 'pipeline-automation', roles: [{ id: 'role-auto', name: 'Pipeline Automation', permissions: [] }], tokenBudget: -1, keys: [], ...over,
});
const keyView = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `key ${id}`, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-12-18T00:00:00.000Z', scope: null, ipAllowlist: null, ...over,
});

const auditActions = () => mockAudit.mock.calls.map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  sa.findServiceAccountByName.mockResolvedValue(null);
  sa.resolveBuiltinRoleId.mockResolvedValue('role-auto');
  sa.createServiceAccount.mockResolvedValue(account());
  sa.createServiceAccountKey.mockResolvedValue({ key: 'pb_sa_rawsecret', view: keyView('k-new') });
});

describe('provision-key — the account', () => {
  it('creates a missing account holding the org\'s built-in Role for `role`, then issues the key', async () => {
    const res = await provision(BODY, { token: await stepUp() });

    expect(res.statusCode).toBe(201);
    expect(sa.resolveBuiltinRoleId).toHaveBeenCalledWith(ORG, 'pipeline_automation');
    expect(sa.createServiceAccount).toHaveBeenCalledWith(
      ORG,
      { name: 'pipeline-automation', description: 'Platform credential for store-token', roleIds: ['role-auto'] },
      expect.objectContaining({ userId: 'user-1', isOrgAdmin: expect.any(Boolean), permissions: USER.permissions }),
    );
    expect(sa.createServiceAccountKey).toHaveBeenCalledWith(
      ORG, 'sa-1', expect.objectContaining({ name: 'store-token 2026-11-18', expiresInSeconds: 30 * 24 * 3600 }), expect.anything(),
    );
    expect(res.body.data).toEqual({
      organizationId: ORG,
      serviceAccount: { id: 'sa-1', name: 'pipeline-automation', created: true },
      key: 'pb_sa_rawsecret',
      accessKey: { id: 'k-new', expiresAt: '2026-12-18T00:00:00.000Z', scope: null },
      retiredKeyIds: [],
    });
  });

  it('reuses an existing account and NEVER touches its Roles', async () => {
    sa.findServiceAccountByName.mockResolvedValue(account({ roles: [] }));
    const res = await provision(BODY, { token: await stepUp() });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.serviceAccount).toEqual({ id: 'sa-1', name: 'pipeline-automation', created: false });
    expect(sa.resolveBuiltinRoleId).not.toHaveBeenCalled();
    expect(sa.createServiceAccount).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(['org.service-account.key.create']);
  });

  it('resolves a concurrent create (SA_NAME_TAKEN) by re-reading the winner\'s account', async () => {
    sa.findServiceAccountByName.mockResolvedValueOnce(null).mockResolvedValueOnce(account({ id: 'sa-raced' }));
    sa.createServiceAccount.mockRejectedValue(new Error('SA_NAME_TAKEN'));
    const res = await provision(BODY, { token: await stepUp() });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.serviceAccount).toEqual({ id: 'sa-raced', name: 'pipeline-automation', created: false });
    expect(sa.createServiceAccountKey).toHaveBeenCalledWith(ORG, 'sa-raced', expect.anything(), expect.anything());
    // Not our create — so not our audit row.
    expect(auditActions()).not.toContain('org.service-account.create');
  });

  it('creates a role-less account when no `role` is given', async () => {
    const { role: _role, ...noRole } = BODY;
    await provision(noRole, { token: await stepUp() });
    expect(sa.resolveBuiltinRoleId).not.toHaveBeenCalled();
    expect(sa.createServiceAccount).toHaveBeenCalledWith(ORG, expect.objectContaining({ roleIds: [] }), expect.anything());
  });

  it('answers 409 SA_BUILTIN_ROLE_MISSING, and creates nothing, when the org has no built-in Role', async () => {
    sa.resolveBuiltinRoleId.mockRejectedValue(new Error('SA_BUILTIN_ROLE_MISSING'));
    const res = await provision(BODY, { token: await stepUp() });

    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/no built-in Role/);
    expect(sa.createServiceAccount).not.toHaveBeenCalled();
    expect(sa.createServiceAccountKey).not.toHaveBeenCalled();
  });

  it('surfaces the creator ceiling refusal from the shared create path as 403', async () => {
    sa.createServiceAccount.mockRejectedValue(new Error('RL_ASSIGN_EXCEEDS_CEILING'));
    const res = await provision(BODY, { token: await stepUp() });
    expect(res.statusCode).toBe(403);
    expect(sa.createServiceAccountKey).not.toHaveBeenCalled();
  });
});

describe('provision-key — the key', () => {
  it('stamps `scope` on the key, not on the account', async () => {
    sa.createServiceAccountKey.mockResolvedValue({ key: 'pb_sa_scoped', view: keyView('k-s', { scope: 'reporting:ingest' }) });
    const { role: _role, ...scoped } = BODY;
    const res = await provision({ ...scoped, accountName: 'reporting-ingest', scope: 'reporting:ingest' }, { token: await stepUp() });

    expect(res.statusCode).toBe(201);
    expect(sa.createServiceAccount).toHaveBeenCalledWith(ORG, expect.not.objectContaining({ scope: expect.anything() }), expect.anything());
    expect(sa.createServiceAccountKey).toHaveBeenCalledWith(ORG, 'sa-1', expect.objectContaining({ scope: 'reporting:ingest' }), expect.anything());
    expect(res.body.data.accessKey).toEqual({ id: 'k-s', expiresAt: '2026-12-18T00:00:00.000Z', scope: 'reporting:ingest' });
  });

  it('at the active-key cap retires the OLDEST active key and retries once — on ONE step-up token', async () => {
    sa.findServiceAccountByName.mockResolvedValue(null);
    sa.createServiceAccountKey
      .mockRejectedValueOnce(new Error('SA_KEY_LIMIT'))
      .mockResolvedValueOnce({ key: 'pb_sa_fresh', view: keyView('k-new') });
    sa.getServiceAccount.mockResolvedValue(account({
      keys: [
        keyView('k-mid', { createdAt: '2026-03-01T00:00:00.000Z' }),
        keyView('k-revoked-older', { createdAt: '2025-01-01T00:00:00.000Z', status: 'revoked' }),
        keyView('k-oldest', { createdAt: '2026-01-01T00:00:00.000Z' }),
        keyView('k-new-ish', { createdAt: '2026-06-01T00:00:00.000Z' }),
      ],
    }));
    sa.revokeServiceAccountKey.mockResolvedValue(keyView('k-oldest'));

    const token = await stepUp();
    const res = await provision(BODY, { token });

    expect(res.statusCode).toBe(201);
    expect(sa.revokeServiceAccountKey).toHaveBeenCalledTimes(1);
    expect(sa.revokeServiceAccountKey).toHaveBeenCalledWith(ORG, 'sa-1', 'k-oldest');
    expect(sa.createServiceAccountKey).toHaveBeenCalledTimes(2);
    expect(res.body.data.retiredKeyIds).toEqual(['k-oldest']);
    expect(res.body.data.key).toBe('pb_sa_fresh');
    // create + retire + issue, in the order they happened, all on one token.
    expect(auditActions()).toEqual(['org.service-account.create', 'org.service-account.key.revoke', 'org.service-account.key.create']);

    // ...and that token is now spent.
    jest.clearAllMocks();
    const replay = await provision(BODY, { token });
    expect(replay.statusCode).toBe(401);
    expect(replay.body.code).toBe('STEP_UP_REPLAY');
    expect(sa.createServiceAccount).not.toHaveBeenCalled();
  });

  it('gives up (409) when the retry is still at the cap, revoking only once', async () => {
    sa.findServiceAccountByName.mockResolvedValue(account());
    sa.createServiceAccountKey.mockRejectedValue(new Error('SA_KEY_LIMIT'));
    sa.getServiceAccount.mockResolvedValue(account({ keys: [keyView('k-oldest')] }));
    sa.revokeServiceAccountKey.mockResolvedValue(keyView('k-oldest'));
    const res = await provision(BODY, { token: await stepUp() });

    expect(res.statusCode).toBe(409);
    expect(sa.revokeServiceAccountKey).toHaveBeenCalledTimes(1);
    expect(sa.createServiceAccountKey).toHaveBeenCalledTimes(2);
  });

  it('writes the SAME audit details the individual routes write', async () => {
    sa.createServiceAccountKey.mockResolvedValue({ key: 'pb_sa_x', view: keyView('k-new', { scope: 'registry:push', ipAllowlist: ['10.0.0.0/8'] }) });
    await provision(BODY, { token: await stepUp() });

    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.service-account.create', {
      targetType: 'service-account',
      targetId: 'sa-1',
      affectedOrgId: ORG,
      details: { name: 'pipeline-automation', roles: ['Pipeline Automation'], tokenBudget: -1, seatsConsumed: 0 },
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.service-account.key.create', {
      targetType: 'access-key',
      targetId: 'k-new',
      affectedOrgId: ORG,
      details: {
        serviceAccountId: 'sa-1',
        keyId: 'k-new',
        name: 'key k-new',
        expiresAt: '2026-12-18T00:00:00.000Z',
        scope: 'registry:push',
        ipAllowlistEntries: 1,
      },
    });
  });
});

describe('provision-key — gates', () => {
  it('401 STEP_UP_REQUIRED without a step-up token, before anything is read or written', async () => {
    const res = await provision(BODY);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('STEP_UP_REQUIRED');
    expect(sa.findServiceAccountByName).not.toHaveBeenCalled();
  });

  it('accepts the `reauth` step-up token the device-authorization flow hands the CLI', async () => {
    const res = await provision(BODY, { token: (await issueStepUpToken(USER.sub, 'reauth')).token });
    expect(res.statusCode).toBe(201);
  });

  it('403 without service_accounts:manage', async () => {
    const res = await provision(BODY, { token: await stepUp(), user: { ...USER, role: 'member', permissions: ['pipelines:read'] } });
    expect(res.statusCode).toBe(403);
    expect(sa.findServiceAccountByName).not.toHaveBeenCalled();
  });

  it('403 for an org outside the caller\'s tenancy', async () => {
    const res = await provision(BODY, { token: await stepUp(), orgId: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
    expect(res.statusCode).toBe(403);
    expect(sa.findServiceAccountByName).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown field', { ...BODY, roleIds: ['r1'] }],
    ['an invalid account name', { ...BODY, accountName: 'Not A Name' }],
    ['an unknown role bundle', { ...BODY, role: 'admin' }],
    ['an unknown scope', { ...BODY, scope: 'everything' }],
    ['a key lifetime over 365 days', { ...BODY, key: { name: 'k', expiresIn: 366 * 24 * 3600 } }],
    ['a key with no lifetime', { ...BODY, key: { name: 'k' } }],
    ['an unknown key field', { ...BODY, key: { ...BODY.key, ipAllowlist: [] } }],
  ])('400 on %s', async (_label, body) => {
    const res = await provision(body, { token: await stepUp() });
    expect(res.statusCode).toBe(400);
    expect(sa.findServiceAccountByName).not.toHaveBeenCalled();
  });
});
