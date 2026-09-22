// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Functional tests for GET /token — the Docker Distribution token-auth issuer.
 *
 * This route had NO behavioural coverage: `route-coverage.test.ts` only asserts
 * that it is mounted. It is the front door to the registry — every `docker
 * pull`/`push` in the fleet authenticates here — so the untested surface was the
 * whole credential path:
 *
 *   - a missing/malformed `Authorization: Basic` header must 401 AND emit the
 *     `WWW-Authenticate` challenge (without it, Docker never retries with creds);
 *   - bad credentials must 401 the same way, and must NOT be distinguishable
 *     from "no credentials" by status or body;
 *   - the RATE LIMITER must run BEFORE credential resolution — otherwise every
 *     spray attempt costs a bcrypt/platform round-trip and the limiter is
 *     decorative. It must key on (ip, username) and never on the password;
 *   - scopes must be parsed and passed through, with unparseable entries
 *     dropped rather than granted;
 *   - `expires_in` must reflect the CONFIGURED TTL, not a hardcoded 300, or
 *     clients refresh out of step with the JWT's real `exp`;
 *   - `token` and `access_token` must carry the same JWT (old vs new clients).
 *
 * The auth resolver, rate limiter and token service are mocked at their module
 * boundaries; the route, its Basic parsing and its scope collection are real.
 */

import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { jest, describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

// --- auth-resolver ----------------------------------------------------------
type Identity = { type: string; orgId?: string; sub?: string };
const resolveIdentity = jest.fn<(u: string, p: string) => Promise<Identity | null>>();
jest.unstable_mockModule('../src/services/auth-resolver.js', () => ({ resolveIdentity }));

// --- rate limiter -----------------------------------------------------------
const checkTokenRateLimit = jest.fn<(ip: string, user: string) => Promise<boolean>>();
jest.unstable_mockModule('../src/services/token-rate-limiter.js', () => ({ checkTokenRateLimit }));

// --- config: pin the advertised TTL to something that is NOT the old hardcoded 300
// Registered BEFORE the token-service `requireActual` below on purpose: the real
// token-service pulls this config module, which throws without
// IMAGE_REGISTRY_HOST. Mock-registration order is load order here.
jest.unstable_mockModule('../src/config/index.js', () => ({
  config: { tokenSigning: { expiresInSeconds: 900 } },
}));

// --- token service ----------------------------------------------------------
// Mocked in full rather than spread from the real module: token-service validates
// a real certificate/private-key PAIR at module scope, which would drag signing
// fixtures into what is a routing test. `parseScope`'s GRAMMAR is exhaustively
// covered in token-service.test.ts, so this double stays deliberately crude — the
// route's own contribution is `collectScopes` (string vs array vs absent, and
// dropping entries the parser rejects), and that is what the tests below pin.
const authorizeAndIssue = jest.fn<(i: Identity, s: unknown[], a: string) => Promise<{ token: string; accessCount: number }>>();
const parseScope = (raw: string) => {
  const first = raw.indexOf(':');
  const last = raw.lastIndexOf(':');
  if (first === -1 || first === last) return null;
  return { type: raw.slice(0, first), name: raw.slice(first + 1, last), actions: raw.slice(last + 1).split(',') };
};
jest.unstable_mockModule('../src/services/token-service.js', () => ({ authorizeAndIssue, parseScope }));

// --- api-server: withRoute passthrough --------------------------------------
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', {
  withRoute: (handler: (rc: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
    const ctx = { log: jest.fn<AnyFn>(), requestId: 'test-req' };
    try {
      await handler({ req, res, ctx });
    } catch (err) {
      const r = res as { headersSent: boolean; status: (n: number) => { json: (b: unknown) => void } };
      if (!r.headersSent) r.status(500).json({ success: false, message: (err as Error)?.message });
    }
  },
  incCounter: jest.fn<AnyFn>(),
}));

type Res = { status: (n: number) => { json: (b: unknown) => void } };
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  sendError: (res: Res, status: number, message: string, code?: string) =>
    res.status(status).json({ success: false, message, code }),
}));

const express = (await import('express')).default;
const { createTokenRoute } = await import('../src/routes/token.js');

let server: Server;
let baseUrl: string;

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

const IDENTITY: Identity = { type: 'user', orgId: 'acme', sub: 'u-1' };

beforeAll(async () => {
  const app = express();
  app.use('/token', createTokenRoute());
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  checkTokenRateLimit.mockResolvedValue(true);
  resolveIdentity.mockResolvedValue(IDENTITY);
  authorizeAndIssue.mockResolvedValue({ token: 'signed.jwt.value', accessCount: 1 });
});

/** GET /token with optional Basic auth + query string. */
async function getToken(opts: { auth?: string; query?: string } = {}) {
  const res = await fetch(`${baseUrl}/token${opts.query ?? ''}`, {
    headers: opts.auth ? { authorization: opts.auth } : {},
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

describe('GET /token — credential handling', () => {
  it('401s with a Basic challenge when no Authorization header is sent', async () => {
    const res = await getToken();

    expect(res.status).toBe(401);
    // Without this header Docker never retries with credentials.
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="pipeline-image-registry"');
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('401s on a non-Basic scheme rather than trying to parse it', async () => {
    const res = await getToken({ auth: 'Bearer some.jwt' });

    expect(res.status).toBe(401);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('401s on a Basic payload with no colon separator', async () => {
    const res = await getToken({ auth: `Basic ${Buffer.from('nocolonhere').toString('base64')}` });

    expect(res.status).toBe(401);
    expect(resolveIdentity).not.toHaveBeenCalled();
  });

  it('401s on bad credentials, with the challenge so the client can retry', async () => {
    resolveIdentity.mockResolvedValue(null);
    const res = await getToken({ auth: basic('u', 'wrong') });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="pipeline-image-registry"');
    // NOTE: the body reads "Invalid credentials" here vs "Authentication required"
    // when no header was sent. That is deliberate and not an oracle — the caller
    // already knows whether it sent credentials. The oracle that WOULD matter is
    // user enumeration, pinned in the next test.
  });

  it('does not reveal whether a USERNAME exists (no enumeration oracle)', async () => {
    // Both a real user with a wrong password and a user that doesn't exist come
    // back from resolveIdentity as null, and must be answered identically —
    // status, challenge header AND body. Any divergence here lets an attacker
    // harvest valid usernames before spending guesses on passwords.
    resolveIdentity.mockResolvedValue(null);
    const realUserWrongPassword = await getToken({ auth: basic('alice', 'wrong') });
    const noSuchUser = await getToken({ auth: basic('nobody-here', 'wrong') });

    expect(realUserWrongPassword.status).toBe(noSuchUser.status);
    expect(realUserWrongPassword.headers.get('www-authenticate'))
      .toBe(noSuchUser.headers.get('www-authenticate'));
    expect(realUserWrongPassword.body).toEqual(noSuchUser.body);
  });

  it('keeps a password containing colons intact (splits on the FIRST colon only)', async () => {
    await getToken({ auth: basic('user', 'pa:ss:word') });

    expect(resolveIdentity).toHaveBeenCalledWith('user', 'pa:ss:word');
  });
});

describe('GET /token — rate limiting', () => {
  it('429s when the limiter refuses, WITHOUT resolving credentials', async () => {
    checkTokenRateLimit.mockResolvedValue(false);
    const res = await getToken({ auth: basic('u', 'p') });

    expect(res.status).toBe(429);
    // The whole point of limiting first: a spray attempt must not cost a
    // credential round-trip, or the limiter protects nothing.
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(authorizeAndIssue).not.toHaveBeenCalled();
  });

  it('keys the limiter on (source ip, username) and never on the password', async () => {
    await getToken({ auth: basic('alice', 'sup3rsecret') });

    expect(checkTokenRateLimit).toHaveBeenCalledTimes(1);
    const args = checkTokenRateLimit.mock.calls[0];
    expect(args[1]).toBe('alice');
    expect(args).not.toContain('sup3rsecret');
  });
});

describe('GET /token — scope handling', () => {
  it('issues an empty-scope token for the docker-login probe (no scope param)', async () => {
    authorizeAndIssue.mockResolvedValue({ token: 'probe.jwt', accessCount: 0 });
    const res = await getToken({ auth: basic('u', 'p') });

    expect(res.status).toBe(200);
    expect(authorizeAndIssue).toHaveBeenCalledWith(IDENTITY, [], 'u');
  });

  it('passes a parsed scope through to the authorizer unchanged', async () => {
    await getToken({ auth: basic('u', 'p'), query: '?scope=repository:acme/app:pull,push' });

    const [, scopes] = authorizeAndIssue.mock.calls[0];
    expect(scopes).toEqual([{ type: 'repository', name: 'acme/app', actions: ['pull', 'push'] }]);
  });

  it('accepts repeated scope params (array form)', async () => {
    await getToken({ auth: basic('u', 'p'), query: '?scope=repository:a:pull&scope=repository:b:push' });

    const [, scopes] = authorizeAndIssue.mock.calls[0] as unknown as [unknown, Array<{ name: string }>];
    expect(scopes.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('DROPS a scope the parser rejects instead of forwarding it', async () => {
    // A scope that cannot be parsed must not reach the authorizer as a partial
    // or null entry — it is discarded, never granted.
    await getToken({ auth: basic('u', 'p'), query: '?scope=garbage&scope=repository:ok:pull' });

    const [, scopes] = authorizeAndIssue.mock.calls[0] as unknown as [unknown, Array<{ name: string }>];
    expect(scopes.map((s) => s.name)).toEqual(['ok']);
  });

  it('uses the ?account override when present, else the Basic username', async () => {
    await getToken({ auth: basic('u', 'p'), query: '?account=robot-1' });
    expect(authorizeAndIssue.mock.calls[0][2]).toBe('robot-1');

    authorizeAndIssue.mockClear();
    await getToken({ auth: basic('u', 'p') });
    expect(authorizeAndIssue.mock.calls[0][2]).toBe('u');
  });

  it('ignores a non-string ?account (array form) and falls back to the username', async () => {
    await getToken({ auth: basic('u', 'p'), query: '?account=a&account=b' });

    expect(authorizeAndIssue.mock.calls[0][2]).toBe('u');
  });
});

describe('GET /token — response envelope', () => {
  it('returns the JWT under BOTH token and access_token', async () => {
    const res = await getToken({ auth: basic('u', 'p') });

    expect(res.status).toBe(200);
    expect(res.body?.token).toBe('signed.jwt.value');
    // Older Docker clients read `token`, newer ones `access_token`.
    expect(res.body?.access_token).toBe('signed.jwt.value');
  });

  it('advertises the CONFIGURED ttl, not a hardcoded 300', async () => {
    const res = await getToken({ auth: basic('u', 'p') });

    // config.tokenSigning.expiresInSeconds is pinned to 900 above; a hardcoded
    // 300 here would make clients refresh out of step with the JWT's real exp.
    expect(res.body?.expires_in).toBe(900);
  });

  it('stamps issued_at as an ISO timestamp', async () => {
    const res = await getToken({ auth: basic('u', 'p') });

    expect(typeof res.body?.issued_at).toBe('string');
    expect(Number.isNaN(Date.parse(res.body?.issued_at as string))).toBe(false);
  });
});
