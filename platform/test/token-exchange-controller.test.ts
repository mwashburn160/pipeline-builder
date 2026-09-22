// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /auth/token/exchange` (controllers/token-exchange.ts).
 *
 * The endpoint is pre-auth, so its whole contract is in what it answers and what
 * it records: one undifferentiated 401 for every refusal (no "which of my
 * guesses named a real key?" oracle), with the actual reason in the audit trail,
 * and a success row attributed to the key's OWNER naming the key that was used.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockExchange = jest.fn<AnyFn>();
const mockRotate = jest.fn<AnyFn>();
const mockRevokeSibling = jest.fn<AnyFn>();
const mockAudit = jest.fn<AnyFn>();
const mockIncCounter = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  sendSuccess: (res: any, status: number, data?: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  apiKeyService: {
    exchange: (...a: unknown[]) => mockExchange(...a),
    rotateServiceAccountKey: (...a: unknown[]) => mockRotate(...a),
    revokeSiblingKey: (...a: unknown[]) => mockRevokeSibling(...a),
  },
}));

const { exchangeToken, rotateKey, revokeKey } = await import('../src/controllers/token-exchange.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockRes() {
  const res: any = {};
  res.status = jest.fn<AnyFn>().mockReturnValue(res);
  res.json = jest.fn<AnyFn>().mockReturnValue(res);
  return res;
}

async function invoke(handler: unknown, body: unknown) {
  const req: any = { body, headers: {}, ip: '203.0.113.7' };
  const res = mockRes();
  await (handler as any)(req, res, jest.fn<AnyFn>());
  return { req, res };
}
const run = (body: unknown) => invoke(exchangeToken, body);
const runRotate = (body: unknown) => invoke(rotateKey, body);
const runRevoke = (body: unknown) => invoke(revokeKey, body);

const SA_KEY = 'pb_sa_0123456789abcdef0123456789abcdef0123456789a';

/** A successful rotation, as `apiKeyService.rotateServiceAccountKey` reports it. */
const ROTATED = {
  ok: true,
  key: 'pb_sa_newsecret',
  previousKeyId: 'key-old',
  serviceAccountId: 'sa-1',
  serviceAccountName: 'deploy-bot',
  organizationId: 'org-1',
  prunedKeyIds: [],
  view: { id: 'key-new', name: 'deploy-bot key', expiresAt: '2027-01-01T00:00:00.000Z', scope: 'registry:push' },
};

const REVOKED = {
  ok: true,
  revokedKeyId: 'key-old',
  alreadyRevoked: false,
  serviceAccountId: 'sa-1',
  serviceAccountName: 'deploy-bot',
  organizationId: 'org-1',
};

const SUCCESS = {
  ok: true,
  accessToken: 'minted.jwt',
  expiresIn: 300,
  keyId: 'key-1',
  keyName: 'ci-deploy',
  userId: 'u1',
  userEmail: 'keys@example.com',
  organizationId: 'org-1',
};

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /auth/token/exchange', () => {
  it('returns the minted token, its lifetime and the key id', async () => {
    mockExchange.mockResolvedValue(SUCCESS);

    const { res } = await run({ key: 'pb_pat_0123456789abcdef0123456789abcdef0123456789a' });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({ accessToken: 'minted.jwt', expiresIn: 300, keyId: 'key-1' });
  });

  it('attributes the success audit row to the key\'s owner and names the key', async () => {
    mockExchange.mockResolvedValue(SUCCESS);

    const { req } = await run({ key: 'pb_pat_0123456789abcdef0123456789abcdef0123456789a' });

    // The request carries no identity until the key resolves, so the controller
    // stamps one — otherwise every exchange would be an `anonymous` row and
    // "what has key X been doing" would be unanswerable.
    expect(req.user).toMatchObject({ sub: 'u1', email: 'keys@example.com', organizationId: 'org-1' });
    expect(mockAudit).toHaveBeenCalledWith(req, 'user.key.exchange', expect.objectContaining({
      targetType: 'access-key',
      targetId: 'key-1',
      details: { name: 'ci-deploy' },
    }));
    expect(mockIncCounter).toHaveBeenCalledWith('platform_api_key_exchange_total', { result: 'success' });
  });

  it.each(['unknown', 'revoked', 'expired', 'authority_revoked', 'user_gone', 'malformed'] as const)(
    'answers one indistinguishable 401 for a %s key while recording the reason',
    async (reason) => {
      mockExchange.mockResolvedValue({ ok: false, reason });

      const { res } = await run({ key: 'pb_pat_0123456789abcdef0123456789abcdef0123456789a' });

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json.mock.calls[0][0]).toEqual({
        success: false, message: 'Invalid or revoked access key', code: 'ACCESS_KEY_INVALID',
      });
      // The reason lives in the audit row only — the response above is byte-identical
      // for every refusal.
      expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'user.key.exchange.failed', expect.objectContaining({
        outcome: 'failure',
        details: { reason },
      }));
      expect(mockIncCounter).toHaveBeenCalledWith('platform_api_key_exchange_failed_total', { reason });
    },
  );

  it('rejects a missing key as a bad request without touching the key service', async () => {
    const { res } = await run({});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('POST /auth/token/exchange — a service-account key', () => {
  it('names the ACCOUNT as the actor and records the scope it was minted with', async () => {
    mockExchange.mockResolvedValue({
      ...SUCCESS,
      principalType: 'service_account',
      serviceAccountName: 'deploy-bot',
      scope: 'registry:push',
      userId: 'sa-1',
      userEmail: 'deploy-bot@service-account.invalid',
    });

    const { req } = await run({ key: SA_KEY });

    // Never the person who happened to create the account.
    expect(req.user).toMatchObject({ sub: 'sa-1', email: 'deploy-bot@service-account.invalid', organizationId: 'org-1' });
    expect(mockAudit).toHaveBeenCalledWith(req, 'user.key.exchange', expect.objectContaining({
      details: { name: 'ci-deploy', principalType: 'service_account', serviceAccount: 'deploy-bot', scope: 'registry:push' },
    }));
    expect(mockIncCounter).toHaveBeenCalledWith('platform_api_key_exchange_total', { result: 'success', principal: 'service_account' });
  });

  it('trims the presented key, so a trailing newline from a shell heredoc still exchanges', async () => {
    mockExchange.mockResolvedValue(SUCCESS);
    await run({ key: `  ${SA_KEY}\n` });
    expect(mockExchange).toHaveBeenCalledWith(SA_KEY, '203.0.113.7');
  });

  it('rejects a non-string key as a bad request', async () => {
    const { res } = await run({ key: { toString: () => SA_KEY } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockExchange).not.toHaveBeenCalled();
  });
});

describe('POST /auth/key/rotate', () => {
  it('mints the sibling, leaves the presented key LIVE, and attributes the row to the account', async () => {
    mockRotate.mockResolvedValue(ROTATED);

    const { req, res } = await runRotate({ key: SA_KEY });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].data).toEqual({
      key: 'pb_sa_newsecret',
      keyId: 'key-new',
      previousKeyId: 'key-old',
      expiresAt: '2027-01-01T00:00:00.000Z',
      scope: 'registry:push',
      prunedKeyIds: [],
    });
    // The caller stores the replacement, THEN retires the old one — so the
    // response must name both, and nothing may have been revoked here.
    expect(req.user).toMatchObject({ sub: 'sa-1', email: 'deploy-bot@service-account.invalid', organizationId: 'org-1' });
    expect(mockAudit).toHaveBeenCalledWith(req, 'org.service-account.key.rotate', expect.objectContaining({
      targetType: 'service-account',
      targetId: 'sa-1',
      affectedOrgId: 'org-1',
      details: expect.objectContaining({ keyId: 'key-new', previousKeyId: 'key-old', prunedKeyIds: [] }),
    }));
    expect(mockIncCounter).toHaveBeenCalledWith('platform_api_key_rotate_total', { result: 'success' });
  });

  it('passes a trimmed, length-bounded name and a parsed lifetime through', async () => {
    mockRotate.mockResolvedValue(ROTATED);

    await runRotate({ key: SA_KEY, name: `  ${'n'.repeat(140)}  `, expiresIn: '3600' });

    expect(mockRotate).toHaveBeenCalledWith(SA_KEY, { name: 'n'.repeat(100), expiresInSeconds: 3600 }, '203.0.113.7');
  });

  it('omits an all-whitespace name rather than storing one', async () => {
    mockRotate.mockResolvedValue(ROTATED);
    await runRotate({ key: SA_KEY, name: '   ' });
    expect(mockRotate).toHaveBeenCalledWith(SA_KEY, {}, '203.0.113.7');
  });

  it('refuses an unparseable expiresIn before touching the key service', async () => {
    const { res } = await runRotate({ key: SA_KEY, expiresIn: 'soon' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_EXPIRES_IN');
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('rejects a missing key without touching the key service', async () => {
    const { res } = await runRotate({});
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockRotate).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('answers 400 for the caller\'s own out-of-range lifetime — the one distinguishable refusal', async () => {
    mockRotate.mockResolvedValue({ ok: false, reason: 'expiry_invalid' });

    const { res } = await runRotate({ key: SA_KEY, expiresIn: '5' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_EXPIRES_IN');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.service-account.key.rotate.failed',
      expect.objectContaining({ outcome: 'failure', details: { reason: 'expiry_invalid' } }));
  });

  it.each(['unknown', 'revoked', 'expired', 'not_service_account', 'ip_not_allowed', 'budget_exhausted'] as const)(
    'answers the same opaque 401 for a %s rotation, with the reason only in the audit row',
    async (reason) => {
      mockRotate.mockResolvedValue({ ok: false, reason });

      const { res } = await runRotate({ key: SA_KEY });

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json.mock.calls[0][0]).toEqual({
        success: false, message: 'Invalid or revoked access key', code: 'ACCESS_KEY_INVALID',
      });
      expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.service-account.key.rotate.failed',
        expect.objectContaining({ outcome: 'failure', details: { reason } }));
      expect(mockIncCounter).toHaveBeenCalledWith('platform_api_key_rotate_failed_total', { reason });
    },
  );
});

describe('POST /auth/key/revoke', () => {
  it('retires the sibling and audits it against the account', async () => {
    mockRevokeSibling.mockResolvedValue(REVOKED);

    const { req, res } = await runRevoke({ key: SA_KEY, keyId: 'key-old' });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({ revoked: true, alreadyRevoked: false });
    expect(mockRevokeSibling).toHaveBeenCalledWith(SA_KEY, 'key-old', '203.0.113.7');
    expect(req.user).toMatchObject({ sub: 'sa-1', organizationId: 'org-1' });
    expect(mockAudit).toHaveBeenCalledWith(req, 'org.service-account.key.revoke', expect.objectContaining({
      targetId: 'sa-1',
      affectedOrgId: 'org-1',
      details: { keyId: 'key-old', alreadyRevoked: false, via: 'self-rotation' },
    }));
    expect(mockIncCounter).toHaveBeenCalledWith('platform_api_key_rotate_total', { result: 'revoked' });
  });

  it('reports an already-revoked sibling as success — a retrying rotator must not see a failure', async () => {
    mockRevokeSibling.mockResolvedValue({ ...REVOKED, alreadyRevoked: true });
    const { res } = await runRevoke({ key: SA_KEY, keyId: 'key-old' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({ revoked: true, alreadyRevoked: true });
  });

  it('refuses a request with no key, and one with no keyId, distinctly', async () => {
    const missingKey = await runRevoke({ keyId: 'key-old' });
    expect(missingKey.res.json.mock.calls[0][0].code).toBe('INVALID_ACCESS_KEY');

    const missingId = await runRevoke({ key: SA_KEY });
    expect(missingId.res.status).toHaveBeenCalledWith(400);
    expect(missingId.res.json.mock.calls[0][0].code).toBe('INVALID_KEY_ID');

    expect(mockRevokeSibling).not.toHaveBeenCalled();
  });

  it('REFUSES a key revoking ITSELF, and says so — a rotator must not destroy what it holds', async () => {
    mockRevokeSibling.mockResolvedValue({ ok: false, reason: 'self_revoke' });

    const { res } = await runRevoke({ key: SA_KEY, keyId: 'key-self' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('SELF_REVOKE_REFUSED');
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), 'org.service-account.key.rotate.failed',
      expect.objectContaining({ targetId: 'key-self', details: { reason: 'self_revoke', operation: 'revoke' } }));
  });

  it('answers the opaque 401 for every other refusal', async () => {
    mockRevokeSibling.mockResolvedValue({ ok: false, reason: 'unknown' });

    const { res } = await runRevoke({ key: SA_KEY, keyId: 'key-old' });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe('ACCESS_KEY_INVALID');
    expect(mockIncCounter).toHaveBeenCalledWith('platform_api_key_rotate_failed_total', { reason: 'unknown' });
  });
});
