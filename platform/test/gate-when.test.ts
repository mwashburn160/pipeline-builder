// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `gateWhen` — gates applied to only SOME requests of a route — composed with
 * the REAL api-core gates and REAL platform-issued step-up tokens, in the two
 * shapes the routes use:
 *   - PATCH /user/profile: `gateWhen('changes the sign-in email', changesOwnEmail, requireStepUp)`;
 *   - POST /users:         `gateWhen('creates a platform super-admin', isSuperAdmin,
 *                                    requireAssurance(aal2), requireStepUp({ methods: STRONG }))`.
 * How the route table records them (`conditionalGates`) is pinned in api-core's
 * route-table.test.ts.
 * The route wiring itself (which predicate, which gates) is pinned in
 * step-up-route-gates.test.ts; the email predicate in user-profile-audit.test.ts.
 *
 * Deep imports: the real api-core modules, not the mocked barrel.
 */

import { jest, describe, it, expect, afterAll } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';

jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ auth: { jwt: {} } }));
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {}, Organization: {}, UserOrganization: {}, Role: {}, RoleAssignment: {},
}));

const ENV = ['JWT_ISSUER', 'JWT_AUDIENCE', 'REDIS_URL', 'REDIS_SENTINELS'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];
const { requireStepUp, STRONG_STEP_UP_METHODS } = await import('@pipeline-builder/api-core/lib/middleware/step-up.js');
const { requireAssurance } = await import('@pipeline-builder/api-core/lib/middleware/assurance.js');
const { issueStepUpToken } = await import('../src/services/session/access-tokens.js');
const { installTestSigningKeys } = await import('./helpers/signing.js');
const { gateWhen } = await import('@pipeline-builder/api-core/lib/middleware/gate-when.js');
installTestSigningKeys();

afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const person = (aal: 1 | 2) => ({ sub: 'u1', principalType: 'user', token_use: 'access', aal });

function mockReq(opts: { user?: Record<string, unknown>; token?: string; body?: Record<string, unknown> }) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['x-step-up-token'] = opts.token;
  return { method: 'PATCH', headers, user: opts.user, body: opts.body ?? {} } as any;
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

/** Run a middleware to completion: resolves when it calls `next` or answers. */
function run(mw: (req: any, res: any, next: AnyFn) => void, req: any) {
  return new Promise<{ passed: boolean; err?: unknown; status?: number; code?: string }>((resolve) => {
    const res = mockRes();
    res.json = jest.fn((body: { code?: string; errorCode?: string }) => {
      resolve({ passed: false, status: res.status.mock.calls[0]?.[0], code: body?.code ?? body?.errorCode });
      return res;
    });
    mw(req, res, (err?: unknown) => resolve({ passed: !err, err }));
  });
}

describe('PATCH /user/profile shape — step-up only when the email changes', () => {
  const emailChanging = (req: any) => Promise.resolve(typeof req.body.email === 'string');
  const mw = gateWhen('changes the sign-in email', emailChanging, requireStepUp);

  it('refuses an email change with no step-up token (401 STEP_UP_REQUIRED)', async () => {
    const r = await run(mw, mockReq({ user: person(1), body: { email: 'attacker@example.com' } }));
    expect(r).toMatchObject({ passed: false, status: 401, code: 'STEP_UP_REQUIRED' });
  });

  it('admits an email change carrying a valid step-up token', async () => {
    const { token } = await issueStepUpToken('u1', 'password');
    const r = await run(mw, mockReq({ user: person(1), token, body: { email: 'new@example.com' } }));
    expect(r.passed).toBe(true);
  });

  it('refuses someone else\'s step-up token (401 STEP_UP_MISMATCH)', async () => {
    const { token } = await issueStepUpToken('someone-else', 'password');
    const r = await run(mw, mockReq({ user: person(1), token, body: { email: 'new@example.com' } }));
    expect(r).toMatchObject({ passed: false, code: 'STEP_UP_MISMATCH' });
  });

  it('leaves a username-only edit ungated', async () => {
    const r = await run(mw, mockReq({ user: person(1), body: { username: 'renamed' } }));
    expect(r.passed).toBe(true);
  });

  it('refuses — never admits ungated — when the predicate throws', async () => {
    const failing = gateWhen('changes the sign-in email', () => Promise.reject(new Error('db down')), requireStepUp);
    const r = await run(failing, mockReq({ user: person(1), body: { email: 'new@example.com' } }));
    expect(r.passed).toBe(false);
    expect(String(r.err)).toContain('db down');
  });
});

describe('POST /users shape — a super-admin create needs aal2 AND a second-factor step-up', () => {
  const mw = gateWhen(
    'creates a platform super-admin',
    (req: any) => req.body?.isSuperAdmin === true,
    requireAssurance({ minAssurance: 2 }),
    requireStepUp({ methods: STRONG_STEP_UP_METHODS }),
  );
  const superAdmin = { username: 'ops2', isSuperAdmin: true };

  it('refuses a single-factor session before any step-up (401 MFA_REQUIRED)', async () => {
    const { token } = await issueStepUpToken('u1', 'totp');
    const r = await run(mw, mockReq({ user: person(1), token, body: superAdmin }));
    expect(r).toMatchObject({ passed: false, status: 401, code: 'MFA_REQUIRED' });
  });

  it('refuses an aal2 session with no step-up token', async () => {
    const r = await run(mw, mockReq({ user: person(2), body: superAdmin }));
    expect(r).toMatchObject({ passed: false, code: 'STEP_UP_REQUIRED' });
  });

  it('refuses a PASSWORD-earned step-up (401 STEP_UP_METHOD_REQUIRED)', async () => {
    const { token } = await issueStepUpToken('u1', 'password');
    const r = await run(mw, mockReq({ user: person(2), token, body: superAdmin }));
    expect(r).toMatchObject({ passed: false, code: 'STEP_UP_METHOD_REQUIRED' });
  });

  it.each(['totp', 'webauthn'] as const)('admits an aal2 session with a %s step-up', async (method) => {
    const { token } = await issueStepUpToken('u1', method);
    const r = await run(mw, mockReq({ user: person(2), token, body: superAdmin }));
    expect(r.passed).toBe(true);
  });

  it('leaves an ordinary account creatable from a single-factor session, with no step-up', async () => {
    const r = await run(mw, mockReq({ user: person(1), body: { username: 'plain' } }));
    expect(r.passed).toBe(true);
  });
});
