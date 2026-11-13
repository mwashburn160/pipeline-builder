// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a SERVICE token may assert about itself — nothing administrative.
 *
 * Two holes this pins shut:
 *
 *  1. `verifyServiceJwt` checked the signature and that `sub` named the key's
 *     owner, then trusted every other claim. A service token saying
 *     `isSuperAdmin: true` (or `role: owner`) was believed by `requireAuth`, so
 *     any service key — and above all the `deploy-bootstrap` key, whose private
 *     half sits on the operator / CI host — minted fleet-wide superadmins.
 *     Now those claims are stripped at verification: a service's authority is
 *     its name plus its explicit `permissions`.
 *  2. The `deploy-bootstrap` public key is in the bundle every service mounts, so
 *     its tokens verified EVERYWHERE. Now every seam refuses that signer unless it
 *     opts in (`requireAuth({ acceptServices })` / `verifyBearerToken(…, {
 *     acceptServices })`).
 *
 * Real key files, real ES256 tokens, real HTTP — the deployed configuration.
 */

import type { AddressInfo } from 'net';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import { requireAuth } from '../src/middleware/auth.js';
import { verifyBearerToken } from '../src/middleware/jwt-verify.js';
import { isSystemAdmin, requirePermission, requireSystemAdmin, userHasPermission } from '../src/middleware/permission-gates.js';
import { signServiceToken, verifyServicePrincipal } from '../src/middleware/service-tokens.js';
import { verifyServiceJwt, withoutServiceAuthorityClaims } from '../src/services/service-keys.js';
import { installTestServiceKeys, type TestServiceKeysHandle } from '../src/testing/service-tokens.js';
import { decodeJwtHeader } from '../src/utils/jwk.js';

/** The claim set the deploy scripts' signer used to write. */
const OLD_BOOTSTRAP_CLAIMS = { organizationId: 'system', organizationName: 'system', isSuperAdmin: true, isAdmin: true, role: 'admin' };

let keys: TestServiceKeysHandle;
let baseUrl: string;
let server: import('http').Server;

/** Echo what the gates saw, so a test can assert on the derived principal. */
const echo = (req: Request, res: Response): void => {
  res.json({
    sub: req.user?.sub,
    role: req.user?.role,
    isAdmin: req.user?.isAdmin,
    isSuperAdmin: req.user?.isSuperAdmin ?? null,
    organizationId: req.user?.organizationId,
    systemAdmin: isSystemAdmin(req),
    holdsAnything: userHasPermission(req, 'quotas:manage'),
  });
};

beforeAll(async () => {
  keys = installTestServiceKeys(['quota', 'billing', 'deploy-bootstrap']);
  keys.becomeService('quota');

  const app = express();
  app.get('/plain', requireAuth, echo);
  app.get('/override', requireAuth({ allowOrgHeaderOverride: true }), echo);
  app.get('/sysadmin', requireAuth, requireSystemAdmin, echo);
  app.get('/billing-manage', requireAuth, requirePermission('billing:manage'), echo);
  // The one-line opt-in a route uses to trust the deploy's signer.
  app.get('/bootstrap-ok', requireAuth({ acceptServices: ['deploy-bootstrap'] }), echo);
  app.get('/bootstrap-sysadmin', requireAuth({ acceptServices: ['deploy-bootstrap'] }), requireSystemAdmin, echo);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  keys.uninstall();
});

async function get(path: string, token: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  keys.becomeService('quota');
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('deploy-bootstrap tokens are refused unless the seam opts in', () => {
  it('a service that has not opted in answers 401 TOKEN_INVALID — even for the old superadmin claim set', async () => {
    const token = keys.sign('deploy-bootstrap', OLD_BOOTSTRAP_CLAIMS);
    for (const path of ['/plain', '/sysadmin', '/override']) {
      const out = await get(path, token);
      expect([path, out.status, (out.body as { code?: string }).code]).toEqual([path, 401, 'TOKEN_INVALID']);
    }
  });

  it('the pre-auth service check (rate-limit exemption) does not recognise it either', () => {
    const token = keys.sign('deploy-bootstrap', OLD_BOOTSTRAP_CLAIMS);
    keys.becomeService('quota');
    expect(verifyServicePrincipal({ headers: { authorization: `Bearer ${token}` } } as Request)).toBe(false);
  });

  it('verifyBearerToken refuses it by default and accepts it when named', async () => {
    const token = keys.sign('deploy-bootstrap', OLD_BOOTSTRAP_CLAIMS);
    keys.becomeService('quota');
    await expect(verifyBearerToken(token)).rejects.toThrow(/not accepted here/);
    await expect(verifyBearerToken(token, { acceptServices: ['billing'] })).rejects.toThrow(/not accepted here/);
    const claims = await verifyBearerToken(token, { acceptServices: ['deploy-bootstrap'] });
    expect(claims.sub).toBe('service:deploy-bootstrap');
    expect(claims).not.toHaveProperty('isSuperAdmin');
  });

  it('an opted-in route admits it as a plain service principal — never a superadmin', async () => {
    const token = keys.sign('deploy-bootstrap', OLD_BOOTSTRAP_CLAIMS);
    const ok = await get('/bootstrap-ok', token);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ sub: 'service:deploy-bootstrap', role: 'member', isAdmin: false, isSuperAdmin: null, systemAdmin: false, holdsAnything: false });
    expect((await get('/bootstrap-sysadmin', token)).status).toBe(403);
  });
});

describe('in-cluster service tokens carry no admin authority', () => {
  it('ignores an isSuperAdmin claim on a service token', async () => {
    const token = keys.sign('billing', { organizationId: 'org-1', isSuperAdmin: true, role: 'owner', isAdmin: true });
    const out = await get('/plain', token);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ isSuperAdmin: null, systemAdmin: false, holdsAnything: false, role: 'member', isAdmin: false });
    expect((await get('/sysadmin', token)).status).toBe(403);
  });

  it('does not let a service token use the sysadmin x-org-id override', async () => {
    const token = keys.sign('billing', { organizationId: 'org-1', isSuperAdmin: true });
    const out = await get('/override', token, { 'x-org-id': 'org-victim' });
    expect(out.status).toBe(200);
    expect(out.body.organizationId).toBe('org-1');
  });

  it('a signServiceToken owner-role token is clamped to member', async () => {
    keys.becomeService('billing');
    const token = signServiceToken({ serviceName: 'billing', orgId: 'org-1', role: 'owner' });
    const out = await get('/plain', token);
    expect(out.body).toMatchObject({ sub: 'service:billing', role: 'member', isAdmin: false });
  });

  it('still honours an explicit least-privilege permissions grant', async () => {
    keys.becomeService('billing');
    const granted = signServiceToken({ serviceName: 'billing', orgId: 'org-1', role: 'member', permissions: ['billing:manage'] });
    expect((await get('/billing-manage', granted)).status).toBe(200);
    keys.becomeService('billing');
    const bare = signServiceToken({ serviceName: 'billing', orgId: 'org-1', role: 'owner' });
    expect((await get('/billing-manage', bare)).status).toBe(403);
  });

  it('verifyServiceJwt itself returns the reduced claims, for every chain that calls it', () => {
    const token = keys.sign('billing', { organizationId: 'org-1', isSuperAdmin: true, role: 'admin', isAdmin: true, permissions: ['billing:manage'] });
    keys.becomeService('quota');
    const claims = verifyServiceJwt<Record<string, unknown>>(token, { kid: decodeJwtHeader(token)!.kid! });
    expect(claims).not.toHaveProperty('isSuperAdmin');
    expect(claims).toMatchObject({ role: 'member', isAdmin: false, permissions: ['billing:manage'] });
  });
});

describe('withoutServiceAuthorityClaims', () => {
  it('leaves a member token and its permissions alone and does not invent fields', () => {
    expect(withoutServiceAuthorityClaims({ role: 'member', permissions: ['plugins:write'] })).toEqual({ role: 'member', permissions: ['plugins:write'] });
  });
});
