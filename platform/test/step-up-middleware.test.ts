// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform MINTS step-up tokens (`issueStepUpToken`); every step-up-gated route —
 * platform's own included — enforces them with api-core's `requireStepUp`. This
 * pins that the two agree: a platform-issued token passes the REAL api-core
 * middleware (same secret, algorithm, issuer/audience and `type`/`jti` claims),
 * and the security properties platform relies on hold end to end.
 *
 * Deep imports: the real api-core modules, not the mocked barrel.
 */

import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import jwt from 'jsonwebtoken';

const SECRET = 'test-step-up-secret';
const jwtConfig: Record<string, unknown> = { secret: SECRET, algorithm: 'HS256' };
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { auth: { jwt: jwtConfig } } }));
// token.ts pulls the models barrel; nothing here touches the database.
jest.unstable_mockModule('../src/models/index.js', () => ({
  User: {}, Organization: {}, UserOrganization: {}, Role: {}, RoleAssignment: {},
}));

const ENV = ['JWT_SECRET', 'JWT_SECRET_PREVIOUS', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_ALGORITHM', 'REDIS_URL', 'REDIS_SENTINELS'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
for (const k of ENV) delete process.env[k];
process.env.JWT_SECRET = SECRET;

const apiCoreAuth = await import('@pipeline-builder/api-core/lib/middleware/auth.js');
const { requireStepUp } = await import('@pipeline-builder/api-core/lib/middleware/step-up.js');
const { issueStepUpToken } = await import('../src/utils/token.js');

function configure(c: { issuer?: string; audience?: string } = {}) {
  Object.assign(jwtConfig, { issuer: c.issuer, audience: c.audience });
  if (c.issuer) process.env.JWT_ISSUER = c.issuer; else delete process.env.JWT_ISSUER;
  if (c.audience) process.env.JWT_AUDIENCE = c.audience; else delete process.env.JWT_AUDIENCE;
  apiCoreAuth._resetJwtSecretCacheForTests();
}

function mockReq(opts: { sub?: string; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['x-step-up-token'] = opts.token;
  return { user: opts.sub ? { sub: opts.sub } : undefined, headers } as any;
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

async function run(req: any) {
  const res = mockRes();
  const next = jest.fn();
  await requireStepUp(req, res, next);
  const body = (res.json as jest.Mock).mock.calls[0]?.[0] as { code?: string; errorCode?: string } | undefined;
  return { res, next, code: body?.code ?? body?.errorCode };
}

beforeEach(() => configure());
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  apiCoreAuth._resetJwtSecretCacheForTests();
});

describe('issueStepUpToken', () => {
  it('binds the token to the user with a fresh jti and the requested TTL', () => {
    const a = jwt.decode(issueStepUpToken('u1', 5).token) as { type: string; sub: string; jti: string; exp: number; iat: number };
    const b = jwt.decode(issueStepUpToken('u1').token) as { jti: string };
    expect(a).toMatchObject({ type: 'step-up', sub: 'u1' });
    expect(a.exp - a.iat).toBe(5);
    expect(a.jti).not.toBe(b.jti);
  });
});

describe('platform step-up tokens under api-core requireStepUp', () => {
  it('accepts a platform-issued token for the same caller', async () => {
    const { next, res } = await run(mockReq({ sub: 'u1', token: issueStepUpToken('u1').token }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts it with issuer/audience pinned on both sides', async () => {
    configure({ issuer: 'pipeline-builder', audience: 'pb-api' });
    const { next } = await run(mockReq({ sub: 'u1', token: issueStepUpToken('u1').token }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('requires the header', async () => {
    const { next, code } = await run(mockReq({ sub: 'u1' }));
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe('STEP_UP_REQUIRED');
  });

  it('rejects a token issued to a different user', async () => {
    const { next, code } = await run(mockReq({ sub: 'u1', token: issueStepUpToken('u-other').token }));
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe('STEP_UP_MISMATCH');
  });

  it('rejects a replay of the same token', async () => {
    const { token } = issueStepUpToken('u1');
    expect((await run(mockReq({ sub: 'u1', token }))).next).toHaveBeenCalled();
    const replay = await run(mockReq({ sub: 'u1', token }));
    expect(replay.next).not.toHaveBeenCalled();
    expect(replay.code).toBe('STEP_UP_REPLAY');
  });

  it('rejects a plain access token signed with the same secret', async () => {
    const access = jwt.sign({ type: 'access', sub: 'u1', jti: 'x' }, SECRET, { algorithm: 'HS256', expiresIn: 60 });
    const { next, code } = await run(mockReq({ sub: 'u1', token: access }));
    expect(next).not.toHaveBeenCalled();
    expect(code).toBe('STEP_UP_INVALID');
  });

  it('exempts a verified service principal', async () => {
    const { next } = await run(mockReq({ sub: 'service:billing' }));
    expect(next).toHaveBeenCalledTimes(1);
  });
});
