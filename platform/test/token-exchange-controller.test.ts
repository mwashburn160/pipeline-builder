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

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockExchange = jest.fn<(...a: unknown[]) => unknown>();
const mockAudit = jest.fn();
const mockIncCounter = jest.fn();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: any, status: number, message: string, code?: string) => res.status(status).json({ success: false, message, code }),
  sendSuccess: (res: any, status: number, data?: unknown) => res.status(status).json({ success: true, data }),
}));
jest.unstable_mockModule('../src/helpers/audit.js', () => ({ audit: (...a: unknown[]) => mockAudit(...a) }));
jest.unstable_mockModule('../src/observability/metrics.js', () => ({ incCounter: (...a: unknown[]) => mockIncCounter(...a) }));
jest.unstable_mockModule('../src/services/index.js', () => ({
  apiKeyService: { exchange: (...a: unknown[]) => mockExchange(...a) },
}));

const { exchangeToken } = await import('../src/controllers/token-exchange.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

async function run(body: unknown) {
  const req: any = { body, headers: {}, ip: '203.0.113.7' };
  const res = mockRes();
  await (exchangeToken as any)(req, res, jest.fn());
  return { req, res };
}

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

beforeEach(() => jest.clearAllMocks());

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
