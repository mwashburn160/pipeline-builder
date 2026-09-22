// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from 'crypto';
import { jest, describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
import { installTestServiceKeys, type TestServiceKeysHandle } from '@pipeline-builder/api-core/lib/testing/service-tokens.js';
import {
  generateTestSigningKey, installTestJwks, signTestUserToken, testUserIdentityClaims,
  type TestSigningKey,
} from '@pipeline-builder/api-core/lib/testing/user-tokens.js';
import jwt from 'jsonwebtoken';
import { apiCoreMock } from './helpers/mock-api-core.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.IMAGE_REGISTRY_USERNAME = 'svc';
process.env.IMAGE_REGISTRY_PASSWORD = 'pw';
process.env.REGISTRY_TOKEN_PRIVATE_KEY = privateKeyPem;
process.env.REGISTRY_TOKEN_CERTIFICATE = publicKeyPem;
// The platform-user (`docker login`) path always posts to the in-cluster
// platform service (PLATFORM_SERVICE_HOST/PORT, default platform:3000).

const mockPost = jest.fn<(...args: unknown[]) => Promise<unknown>>();

// ESM module mocks must be registered with jest.unstable_mockModule BEFORE the
// module under test is (dynamically) imported.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('axios', () => ({
  default: { post: (...args: unknown[]) => mockPost(...args) },
}));

const { resolveIdentity } = await import('../src/services/auth-resolver.js');

/**
 * Platform's signing key, published through the JWKS this suite installs. User
 * tokens are ES256 since #5, so this is the only way to produce one a verifier
 * accepts.
 */
const signingKey: TestSigningKey = generateTestSigningKey();
installTestJwks([signingKey]);

/**
 * Real per-service key files (#14), as the deploy writes them: `plugin` is the
 * legitimate pusher, `evil` stands in for any other service that holds a valid
 * key of its own and tries to speak for plugin.
 */
const serviceKeys: TestServiceKeysHandle = installTestServiceKeys(['plugin', 'evil']);

/** A platform-minted USER credential: ES256, with the identity claims every
 *  verifier requires. It always carries `type: 'access'`; the mint path refuses
 *  anything else (including a token with no `type` at all). */
function signPlatformJwt(payload: Record<string, unknown>): Promise<string> {
  return signTestUserToken(
    { ...testUserIdentityClaims(), role: 'member', ...payload },
    { key: signingKey, expiresIn: 600 },
  );
}

/**
 * A SERVICE-ACCOUNT credential as platform mints it from a `pb_sa_…` key:
 * `principalType: 'service_account'`, `token_use: 'api_key'`, no human
 * assurance to inherit, and — when scoped — no permissions and no admin flags
 * at all. That last part is why the resolver has to honour the scope: a scoped
 * push identity can never carry `plugins:write`.
 */
function signServiceAccountJwt(payload: Record<string, unknown>): Promise<string> {
  return signTestUserToken(
    {
      type: 'access',
      principalType: 'service_account',
      token_use: 'api_key',
      amr: [],
      aal: 1,
      auth_time: Math.floor(Date.now() / 1000),
      role: 'member',
      isAdmin: false,
      permissions: [],
      ...payload,
    },
    { key: signingKey, expiresIn: 600 },
  );
}

describe('resolveIdentity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Service-account push credentials (#12) ────────────────────────────────

  it('grants push to a registry:push-SCOPED service-account token', async () => {
    const token = await signServiceAccountJwt({ sub: 'sa-1', organizationId: 'acme', scope: 'registry:push' });
    expect(await resolveIdentity('acme', token)).toEqual({
      type: 'jwt',
      orgId: 'acme',
      userId: 'sa-1',
      isAdmin: false,
      isSuperAdmin: false,
      // The whole point: no permissions claim, yet the scope grants the write.
      canWritePlugins: true,
    });
  });

  it('does NOT grant push to a service-account token scoped to something else', async () => {
    const token = await signServiceAccountJwt({ sub: 'sa-2', organizationId: 'acme', scope: 'reporting:ingest' });
    expect(await resolveIdentity('acme', token)).toMatchObject({ canWritePlugins: false });
  });

  it('a registry:push scope never confers admin or cross-org authority', async () => {
    // Even if a forged token claims them, the scope alone must not be read as
    // admin — those flags come from the token and are false on a scoped mint.
    const token = await signServiceAccountJwt({ sub: 'sa-3', organizationId: 'acme', scope: 'registry:push' });
    const identity = await resolveIdentity('acme', token) as { isAdmin: boolean; isSuperAdmin: boolean; orgId: string };
    expect(identity.isAdmin).toBe(false);
    expect(identity.isSuperAdmin).toBe(false);
    expect(identity.orgId).toBe('acme');
  });

  it('resolves a valid platform JWT (password)', async () => {
    const token = await signPlatformJwt({ sub: 'user-1', organizationId: 'acme', isAdmin: false });
    const identity = await resolveIdentity('orgname', token);
    expect(identity).toEqual({ type: 'jwt', orgId: 'acme', userId: 'user-1', isAdmin: false, isSuperAdmin: false, canWritePlugins: false });
  });

  it('carries a team token\'s signed parentOrganizationId as parentOrgId', async () => {
    const token = await signPlatformJwt({ sub: 'user-1', organizationId: 'acme-team', parentOrganizationId: 'acme' });
    expect(await resolveIdentity('orgname', token)).toMatchObject({ orgId: 'acme-team', parentOrgId: 'acme' });
  });

  it('drops a malformed parentOrganizationId instead of granting on it', async () => {
    const token = await signPlatformJwt({ sub: 'user-1', organizationId: 'acme-team', parentOrganizationId: '../system' });
    const identity = await resolveIdentity('orgname', token);
    expect(identity).toMatchObject({ orgId: 'acme-team' });
    expect(identity).not.toHaveProperty('parentOrgId');
  });

  it('sets canWritePlugins from a plugins:write permission claim', async () => {
    const token = await signPlatformJwt({ sub: 'writer-1', organizationId: 'acme', isAdmin: false, permissions: ['plugins:write'] });
    expect(await resolveIdentity('orgname', token)).toMatchObject({ canWritePlugins: true, isAdmin: false });
  });

  it('resolves admin JWT with isAdmin flag preserved', async () => {
    const token = await signPlatformJwt({ sub: 'admin-1', organizationId: '000000000000000000000001', isAdmin: true });
    await expect(resolveIdentity('system', token)).resolves.toEqual({
      type: 'jwt',
      orgId: '000000000000000000000001',
      userId: 'admin-1',
      isAdmin: true,
      isSuperAdmin: false,
      canWritePlugins: true,
    });
  });

  it('resolves super-admin JWT with isSuperAdmin flag preserved', async () => {
    const token = await signPlatformJwt({
      sub: 'bootstrap-push',
      organizationId: '000000000000000000000001',
      isAdmin: true,
      isSuperAdmin: true,
    });
    await expect(resolveIdentity('system', token)).resolves.toEqual({
      type: 'jwt',
      orgId: '000000000000000000000001',
      userId: 'bootstrap-push',
      isAdmin: true,
      isSuperAdmin: true,
      canWritePlugins: true,
    });
  });

  it('returns null for an invalid JWT when platform login also rejects it', async () => {
    mockPost.mockResolvedValueOnce({ status: 401, data: { success: false, statusCode: 401, message: 'Invalid credentials' } });
    await expect(resolveIdentity('whoever', 'not-a-jwt')).resolves.toBeNull();
  });

  it('does not call platform at all when the password is a valid platform JWT', async () => {
    const token = await signPlatformJwt({ sub: 'user-1', organizationId: 'acme' });
    await resolveIdentity('whoever', token);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('returns null for JWT verified but missing organizationId', async () => {
    const token = await signPlatformJwt({ sub: 'user-x' });
    await expect(resolveIdentity('whoever', token)).resolves.toBeNull();
  });

  it('returns null for a token signed by an unpublished key', async () => {
    const token = await signTestUserToken(
      { ...testUserIdentityClaims(), sub: 'user-x', role: 'member', organizationId: 'acme' },
      { key: generateTestSigningKey(), expiresIn: 600 },
    );
    await expect(resolveIdentity('whoever', token)).resolves.toBeNull();
  });

  it('REFUSES an HS256 token that claims to be a user, whatever it claims', async () => {
    // No shared secret can mint registry credentials for a person — the reason
    // for the asymmetric-signing cutover.
    const forged = jwt.sign(
      { ...testUserIdentityClaims(), sub: 'user-x', role: 'owner', organizationId: 'acme', isSuperAdmin: true },
      'any-shared-secret',
      { expiresIn: 600 },
    );
    await expect(resolveIdentity('whoever', forged)).resolves.toBeNull();
  });

  it('resolves an internal SERVICE token — api/plugin\'s own image pushes', async () => {
    // Since #14 a service token is ES256 signed with that service's OWN key, so
    // this mints one exactly as the plugin process would (role member +
    // plugins:write) to push the image it just built.
    const token = serviceKeys.sign('plugin', { organizationId: 'acme', permissions: ['plugins:write'] });
    await expect(resolveIdentity('_token', token)).resolves.toMatchObject({
      type: 'jwt', orgId: 'acme', userId: 'service:plugin', canWritePlugins: true, serviceName: 'plugin',
    });
  });

  it('names the service ONLY for a service token — a user token never carries serviceName (quarantine/* gate)', async () => {
    const user = await resolveIdentity('whoever', await signPlatformJwt({ sub: 'service:plugin', organizationId: 'acme' }));
    expect(user).not.toBeNull();
    expect(user).not.toHaveProperty('serviceName');
  });

  it('REFUSES a service token signed by a DIFFERENT service than its subject names', async () => {
    // The cross-service forgery the shared secret made undetectable: `evil` has
    // a valid key of its own, but it is not plugin's.
    await expect(resolveIdentity('_token', serviceKeys.signAs('evil', 'plugin', { organizationId: 'acme' })))
      .resolves.toBeNull();
  });

  it('resolves a JWT whose type claim is "access"', async () => {
    const token = await signPlatformJwt({ sub: 'user-2', organizationId: 'acme', isAdmin: false, type: 'access' });
    await expect(resolveIdentity('orgname', token)).resolves.toMatchObject({ type: 'jwt', orgId: 'acme', userId: 'user-2' });
  });

  it('rejects a non-access token type (e.g. a refresh token) on the mint path', async () => {
    // Defense-in-depth: only an access token may mint registry credentials.
    const token = await signPlatformJwt({ sub: 'user-3', organizationId: 'acme', isAdmin: false, type: 'refresh' });
    await expect(resolveIdentity('orgname', token)).resolves.toBeNull();
  });

  it('rejects a JWT with NO type claim — every platform mint carries one', async () => {
    const token = await signTestUserToken(
      { ...testUserIdentityClaims(), type: undefined, sub: 'user-4', role: 'member', organizationId: 'acme' },
      { key: signingKey, expiresIn: 600 },
    );
    await expect(resolveIdentity('orgname', token)).resolves.toBeNull();
  });
});

/**
 * Path 2 (`docker login` with a platform username/password). Platform answers
 * `/auth/login` via api-core's `sendSuccess` envelope — the token is at
 * `data.accessToken`, not top level. Host/port come from PLATFORM_SERVICE_HOST/
 * PORT (the in-cluster address every service uses), so re-import with them set.
 */
describe('resolveIdentity — platform-user path', () => {
  let resolveIdentityWithPlatform: typeof resolveIdentity;

  beforeAll(async () => {
    process.env.PLATFORM_SERVICE_HOST = 'platform-svc';
    process.env.PLATFORM_SERVICE_PORT = '4000';
    jest.resetModules();
    ({ resolveIdentity: resolveIdentityWithPlatform } = await import(
      '../src/services/auth-resolver.js'
    ));
  });

  afterAll(() => {
    delete process.env.PLATFORM_SERVICE_HOST;
    delete process.env.PLATFORM_SERVICE_PORT;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const envelope = (accessToken: string) => ({
    success: true,
    statusCode: 200,
    data: { accessToken, refreshToken: 'r', expiresIn: 900 },
  });

  it('resolves identity from the sendSuccess-wrapped login response, via the in-cluster URL', async () => {
    const platformJwt = await signPlatformJwt({ sub: 'user-9', organizationId: 'acme', isAdmin: false });
    mockPost.mockResolvedValueOnce({ status: 200, data: envelope(platformJwt) });

    const identity = await resolveIdentityWithPlatform('user@acme.com', 'real-password');

    expect(mockPost).toHaveBeenCalledWith(
      'http://platform-svc:4000/auth/login',
      { identifier: 'user@acme.com', password: 'real-password' },
      expect.objectContaining({
        timeout: 5000,
        // Identified as a service so platform's per-IP login limiter doesn't pool
        // every docker login under this pod's IP.
        headers: { authorization: 'Bearer service-token-for-image-registry' },
      }),
    );
    expect(identity).toEqual({ type: 'jwt', orgId: 'acme', userId: 'user-9', isAdmin: false, isSuperAdmin: false, canWritePlugins: false });
  });

  it('rejects an UNWRAPPED top-level accessToken (not what platform sends)', async () => {
    const platformJwt = await signPlatformJwt({ sub: 'user-9', organizationId: 'acme' });
    mockPost.mockResolvedValueOnce({ status: 200, data: { accessToken: platformJwt } });
    await expect(resolveIdentityWithPlatform('user@acme.com', 'pw')).resolves.toBeNull();
  });

  it('returns null when platform login returns 401', async () => {
    mockPost.mockResolvedValueOnce({ status: 401, data: { success: false, statusCode: 401, message: 'Invalid credentials' } });
    await expect(resolveIdentityWithPlatform('user@acme.com', 'wrong')).resolves.toBeNull();
  });

  it('returns null when platform call throws', async () => {
    mockPost.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(resolveIdentityWithPlatform('user@acme.com', 'pw')).resolves.toBeNull();
  });

  it('returns null when JWT from platform is missing organizationId', async () => {
    const platformJwt = await signPlatformJwt({ sub: 'user-9' });
    mockPost.mockResolvedValueOnce({ status: 200, data: envelope(platformJwt) });
    await expect(resolveIdentityWithPlatform('user@acme.com', 'pw')).resolves.toBeNull();
  });
});
