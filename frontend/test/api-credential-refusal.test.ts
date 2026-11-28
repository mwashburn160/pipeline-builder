// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Only a 401 that says the ACCESS TOKEN is no good (`TOKEN_EXPIRED`,
 * `TOKEN_INVALID`, `TOKEN_MISSING`, `TOKEN_REVOKED`) is answered with a token
 * refresh and a retry. Every other 401 — a refused credential above all (a
 * wrong authenticator code, password or passkey) — surfaces as itself, so a
 * wrong code is POSTed exactly once and counts once toward the lockout.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { ApiCore } from '../src/lib/api/core';
import { authApi } from '../src/lib/api/domains/auth';
import { ApiError } from '../src/lib/api/errors';

function accessToken(sub: string, secondsFromNow = 3600): string {
  const body = { sub, organizationId: 'org-1', exp: Math.floor(Date.now() / 1000) + secondsFromNow };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `h.${payload}.s`;
}

function res(status: number, body: unknown = {}) {
  return { status, ok: status < 400, headers: new Headers(), json: async () => body } as unknown as Response;
}

const TOTP_REFUSAL = { success: false, statusCode: 401, code: 'TOTP_INVALID_CODE', message: 'That code isn\'t right.' };

describe('ApiCore: which 401s refresh and retry', () => {
  let fetchMock: jest.Mock<AnyFn>;
  let core: ApiCore;

  beforeEach(() => {
    fetchMock = jest.fn<AnyFn>();
    global.fetch = fetchMock as unknown as typeof fetch;
    core = new ApiCore();
    core.setTokens({ accessToken: accessToken('u1') });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  const callsTo = (suffix: string) => fetchMock.mock.calls.filter(([u]) => (u as string).endsWith(suffix));

  it('POSTs a wrong step-up code exactly once — no refresh, no re-POST', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.endsWith('/api/auth/refresh')
      ? res(200, { data: { accessToken: accessToken('u1-rotated') } })
      : res(401, TOTP_REFUSAL)));

    const err = await authApi(core).stepUpWithTotp('000000').catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('TOTP_INVALID_CODE');
    expect(callsTo('/api/auth/step-up/totp')).toHaveLength(1);
    expect(callsTo('/api/auth/refresh')).toHaveLength(0);
    // The session is untouched by a refused credential.
    expect(localStorage.getItem('pb.session')).toBe('1');
  });

  it.each([
    ['INVALID_CREDENTIALS'],
    ['UNAUTHORIZED'],
    [undefined],
  ])('does not refresh-and-retry a 401 with code %s', async (code) => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.endsWith('/api/auth/refresh')
      ? res(200, { data: { accessToken: accessToken('u1-rotated') } })
      : res(401, { success: false, message: 'Refused', ...(code ? { code } : {}) })));

    const err = await core.request('/api/auth/step-up', { method: 'POST', body: '{"password":"x"}' }).catch((e) => e);

    expect((err as ApiError).statusCode).toBe(401);
    expect(callsTo('/api/auth/step-up')).toHaveLength(1);
    expect(callsTo('/api/auth/refresh')).toHaveLength(0);
  });

  it.each([['TOKEN_EXPIRED'], ['TOKEN_INVALID'], ['TOKEN_MISSING'], ['TOKEN_REVOKED']])(
    'refreshes once and retries a 401 %s',
    async (code) => {
      let first = true;
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/api/auth/refresh')) return Promise.resolve(res(200, { data: { accessToken: accessToken('u1-rotated') } }));
        if (first) { first = false; return Promise.resolve(res(401, { success: false, code, message: 'Token has expired' })); }
        return Promise.resolve(res(200, { success: true, data: { ok: 1 } }));
      });

      await expect(core.request('/api/pipelines')).resolves.toEqual({ success: true, data: { ok: 1 } });
      expect(callsTo('/api/pipelines')).toHaveLength(2);
      expect(callsTo('/api/auth/refresh')).toHaveLength(1);
    },
  );

  it('a refused credential under impersonation does not end the impersonation', async () => {
    core.startImpersonation(accessToken('target'));
    const expired = jest.fn<AnyFn>();
    core.onSessionExpired(expired);
    fetchMock.mockResolvedValue(res(401, TOTP_REFUSAL));

    await authApi(core).stepUpWithTotp('000000').catch(() => undefined);

    expect(expired).not.toHaveBeenCalled();
  });
});
