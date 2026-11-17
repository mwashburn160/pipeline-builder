// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `requireInteractiveSession` — only a person's own session may mint or destroy
 * sign-in credential material (passkeys, TOTP, recovery codes) or approve a
 * device sign-in.
 */

import { jest, describe, it, expect } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  isServicePrincipal: (req: any) => req.user?.principalType === 'service',
  isServiceAccountPrincipal: (req: any) => req.user?.principalType === 'service_account',
  sendError: (res: any, status: number, msg: string, code?: string) =>
    res.status(status).json({ success: false, message: msg, code }),
}));

const { requireInteractiveSession } = await import('../src/middleware/require-interactive-session.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
function run(user: Record<string, unknown> | undefined) {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  const next = jest.fn();
  requireInteractiveSession({ user } as any, res, next);
  return { res, next };
}

const SESSION = { sub: 'u1', sid: 's1', principalType: 'user', token_use: 'access' };

describe('requireInteractiveSession', () => {
  it('admits a person\'s own session', () => {
    expect(run(SESSION).next).toHaveBeenCalled();
  });

  it.each([
    ['no session slot', { ...SESSION, sid: undefined }],
    ['a scoped machine credential', { ...SESSION, scope: 'reporting:ingest' }],
    ['a permission-restricted credential', { ...SESSION, permissionsRestricted: true, permissions: ['pipelines:read'] }],
    ['an impersonation session', { ...SESSION, impersonatorId: 'op-1' }],
    ['an exchanged access key', { ...SESSION, token_use: 'api_key' }],
    ['a service principal', { ...SESSION, principalType: 'service' }],
  ])('refuses %s', (_label, user) => {
    const { res, next } = run(user);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERACTIVE_SESSION_REQUIRED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated request', () => {
    expect(run(undefined).next).not.toHaveBeenCalled();
  });
});
