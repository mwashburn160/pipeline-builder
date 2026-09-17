// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from 'crypto';
import { jest, describe, it, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
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
process.env.JWT_SECRET = 'test-jwt-secret';
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

function signPlatformJwt(payload: Record<string, unknown>): string {
  return jwt.sign(payload, 'test-jwt-secret');
}

describe('resolveIdentity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a valid platform JWT (password)', async () => {
    const token = signPlatformJwt({ sub: 'user-1', organizationId: 'acme', isAdmin: false });
    const identity = await resolveIdentity('orgname', token);
    expect(identity).toEqual({ type: 'jwt', orgId: 'acme', userId: 'user-1', isAdmin: false, isSuperAdmin: false, canWritePlugins: false });
  });

  it('sets canWritePlugins from a plugins:write permission claim', async () => {
    const token = signPlatformJwt({ sub: 'writer-1', organizationId: 'acme', isAdmin: false, permissions: ['plugins:write'] });
    expect(await resolveIdentity('orgname', token)).toMatchObject({ canWritePlugins: true, isAdmin: false });
  });

  it('resolves admin JWT with isAdmin flag preserved', async () => {
    const token = signPlatformJwt({ sub: 'admin-1', organizationId: '000000000000000000000001', isAdmin: true });
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
    const token = signPlatformJwt({
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
    const token = signPlatformJwt({ sub: 'user-1', organizationId: 'acme' });
    await resolveIdentity('whoever', token);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('returns null for JWT verified but missing organizationId', async () => {
    const token = signPlatformJwt({ sub: 'user-x' });
    await expect(resolveIdentity('whoever', token)).resolves.toBeNull();
  });

  it('returns null for JWT signed with the wrong secret', async () => {
    const token = jwt.sign({ sub: 'user-x', organizationId: 'acme' }, 'different-secret');
    await expect(resolveIdentity('whoever', token)).resolves.toBeNull();
  });

  it('resolves a JWT whose type claim is "access"', async () => {
    const token = signPlatformJwt({ sub: 'user-2', organizationId: 'acme', isAdmin: false, type: 'access' });
    await expect(resolveIdentity('orgname', token)).resolves.toMatchObject({ type: 'jwt', orgId: 'acme', userId: 'user-2' });
  });

  it('rejects a non-access token type (e.g. a refresh token) on the mint path', async () => {
    // Defense-in-depth: only an access token may mint registry credentials.
    const token = signPlatformJwt({ sub: 'user-3', organizationId: 'acme', isAdmin: false, type: 'refresh' });
    await expect(resolveIdentity('orgname', token)).resolves.toBeNull();
  });

  it('still resolves a JWT with no type claim (backward-compat)', async () => {
    const token = signPlatformJwt({ sub: 'user-4', organizationId: 'acme', isAdmin: false });
    await expect(resolveIdentity('orgname', token)).resolves.toMatchObject({ type: 'jwt', orgId: 'acme', userId: 'user-4' });
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
    const platformJwt = signPlatformJwt({ sub: 'user-9', organizationId: 'acme', isAdmin: false });
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
    const platformJwt = signPlatformJwt({ sub: 'user-9', organizationId: 'acme' });
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
    const platformJwt = signPlatformJwt({ sub: 'user-9' });
    mockPost.mockResolvedValueOnce({ status: 200, data: envelope(platformJwt) });
    await expect(resolveIdentityWithPlatform('user@acme.com', 'pw')).resolves.toBeNull();
  });
});
