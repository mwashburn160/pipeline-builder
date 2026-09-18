// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The MESH-LESS internal-route drill (#14).
 *
 * docker compose runs no service mesh, so there is no Istio `AuthorizationPolicy`
 * and no network position to lean on: every internal route has to be safe on the
 * TOKEN ALONE. This test runs exactly that configuration — a real HTTP server on
 * loopback, real per-service key files on disk, real ES256 tokens, nothing in
 * between — and proves the four refusals the guarantee rests on:
 *
 *   1. an anonymous request is refused;
 *   2. a platform-signed USER token is refused, even a superadmin's;
 *   3. a token from a service that is not an allowed caller is refused;
 *   4. a token whose `sub` names an allowed caller but which was SIGNED by a
 *      different service is refused — the cross-service forgery the shared
 *      `JWT_SECRET` could not detect, because every service held it.
 *
 * Only (5) the real caller, with its own key, gets through.
 *
 * Requests go over real HTTP rather than a mocked `req`/`res` precisely so
 * nothing about the transport is assumed: what is exercised is what compose
 * exposes.
 */

import type { AddressInfo } from 'net';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import { requireAuth, requireInternalService } from '../src/middleware/auth.js';
import { installTestServiceKeys, type TestServiceKeysHandle } from '../src/testing/service-tokens.js';
import {
  installTestJwks, signTestUserToken, testUserIdentityClaims, uninstallTestJwks,
  type TestJwksHandle,
} from '../src/testing/user-tokens.js';

/** The route under test: quota's usage counter, whose only callers are peers. */
const INTERNAL_PATH = '/quotas/org-1/increment';

let keys: TestServiceKeysHandle;
let jwks: TestJwksHandle;
let baseUrl: string;
let server: import('http').Server;

beforeAll(async () => {
  // `quota` is the process serving the route; `pipeline` is an allowed caller,
  // `ask` is a real service that is NOT allowed here, `evil` stands in for any
  // workload that got hold of some other service's key.
  keys = installTestServiceKeys(['quota', 'pipeline', 'ask', 'evil']);
  keys.becomeService('quota');
  jwks = installTestJwks();

  const app = express();
  app.post(
    '/quotas/:orgId/increment',
    requireAuth,
    requireInternalService({ callers: ['pipeline', 'plugin'] }),
    (req, res) => { res.json({ caller: req.user?.sub }); },
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  uninstallTestJwks();
  keys.uninstall();
});

async function post(authorization?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${INTERNAL_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: '{}',
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('internal route with no service mesh', () => {
  it('refuses an anonymous request', async () => {
    expect((await post()).status).toBe(401);
  });

  it('refuses a platform-signed USER token', async () => {
    const token = await signTestUserToken(
      { ...testUserIdentityClaims(), sub: 'user-1', role: 'member' },
      { key: jwks.primary },
    );
    expect((await post(`Bearer ${token}`)).status).toBe(403);
  });

  it('refuses a SUPERADMIN user token — privilege is not a substitute for being a service', async () => {
    const token = await signTestUserToken(
      { ...testUserIdentityClaims(), sub: 'root', role: 'owner', isAdmin: true, isSuperAdmin: true },
      { key: jwks.primary },
    );
    expect((await post(`Bearer ${token}`)).status).toBe(403);
  });

  it('refuses a valid token from a service that is not an allowed caller', async () => {
    const token = keys.sign('ask', { organizationId: 'org-1' });
    keys.becomeService('quota');
    expect((await post(`Bearer ${token}`)).status).toBe(403);
  });

  it('refuses a token signed by the WRONG service, however right its subject looks', async () => {
    // `sub: service:pipeline` (an allowed caller), signed with `evil`'s key.
    const forged = keys.signAs('evil', 'pipeline', { organizationId: 'org-1' });
    // 401, not 403: this never becomes an identity at all, so it is refused
    // before the caller allow-list is even consulted.
    expect((await post(`Bearer ${forged}`)).status).toBe(401);
  });

  it('refuses an HS256 token, whatever secret signed it', async () => {
    const { default: jwt } = await import('jsonwebtoken');
    const token = jwt.sign(
      { sub: 'service:pipeline', type: 'access', role: 'member', principalType: 'service', token_use: 'access', organizationId: 'org-1' },
      'any-shared-secret',
      { expiresIn: 300 },
    );
    expect((await post(`Bearer ${token}`)).status).toBe(401);
  });

  it('admits the real caller, signed with its own key', async () => {
    const token = keys.sign('pipeline', { organizationId: 'org-1' });
    keys.becomeService('quota');
    const out = await post(`Bearer ${token}`);
    expect(out).toEqual({ status: 200, body: { caller: 'service:pipeline' } });
  });
});
