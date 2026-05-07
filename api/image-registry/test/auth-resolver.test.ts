// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from 'crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.IMAGE_REGISTRY_USERNAME = 'svc';
process.env.IMAGE_REGISTRY_PASSWORD = 'pw';
process.env.REGISTRY_TOKEN_PRIVATE_KEY = privateKeyPem;
process.env.REGISTRY_TOKEN_CERTIFICATE = publicKeyPem;
process.env.JWT_SECRET = 'test-jwt-secret';
// Default: platform-user path disabled. Tests that exercise it set
// PLATFORM_BASE_URL via jest.isolateModules to opt in per-test.

import axios from 'axios';
import jwt from 'jsonwebtoken';
import { resolveIdentity } from '../src/services/auth-resolver';

jest.mock('axios');
const mockAxios = axios as jest.Mocked<typeof axios>;

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
    expect(identity).toEqual({ type: 'jwt', orgId: 'acme', userId: 'user-1', isAdmin: false });
  });

  it('resolves admin JWT with isAdmin flag preserved', async () => {
    const token = signPlatformJwt({ sub: 'admin-1', organizationId: 'system', isAdmin: true });
    await expect(resolveIdentity('system', token)).resolves.toEqual({
      type: 'jwt',
      orgId: 'system',
      userId: 'admin-1',
      isAdmin: true,
    });
  });

  it('returns null for invalid JWT (platform-user disabled)', async () => {
    await expect(resolveIdentity('whoever', 'not-a-jwt')).resolves.toBeNull();
    // Platform-user path requires PLATFORM_BASE_URL — unset in this test
    // suite, so axios should never be called.
    expect(mockAxios.post).not.toHaveBeenCalled();
  });

  it('returns null for JWT verified but missing organizationId', async () => {
    const token = signPlatformJwt({ sub: 'user-x' });
    await expect(resolveIdentity('whoever', token)).resolves.toBeNull();
  });

  it('returns null for JWT signed with the wrong secret', async () => {
    const token = jwt.sign({ sub: 'user-x', organizationId: 'acme' }, 'different-secret');
    await expect(resolveIdentity('whoever', token)).resolves.toBeNull();
  });
});

/**
 * Platform-user (`docker login`) path. Re-imports the module after setting
 * PLATFORM_BASE_URL so the config snapshot picks up the env change.
 */
describe('resolveIdentity — platform-user path', () => {
  let resolveIdentityWithPlatform: typeof resolveIdentity;

  beforeAll(() => {
    process.env.PLATFORM_BASE_URL = 'https://platform.example.com';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      resolveIdentityWithPlatform = require('../src/services/auth-resolver').resolveIdentity;
    });
  });

  afterAll(() => {
    delete process.env.PLATFORM_BASE_URL;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves identity when platform login returns a valid JWT', async () => {
    const platformJwt = signPlatformJwt({ sub: 'user-9', organizationId: 'acme', isAdmin: false });
    mockAxios.post.mockResolvedValueOnce({ status: 200, data: { accessToken: platformJwt } });

    const identity = await resolveIdentityWithPlatform('user@acme.com', 'real-password');

    expect(mockAxios.post).toHaveBeenCalledWith(
      'https://platform.example.com/auth/login',
      { identifier: 'user@acme.com', password: 'real-password' },
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(identity).toEqual({ type: 'jwt', orgId: 'acme', userId: 'user-9', isAdmin: false });
  });

  it('returns null when platform login returns no accessToken', async () => {
    mockAxios.post.mockResolvedValueOnce({ status: 401, data: {} });
    await expect(resolveIdentityWithPlatform('user@acme.com', 'wrong')).resolves.toBeNull();
  });

  it('returns null when platform call throws', async () => {
    mockAxios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(resolveIdentityWithPlatform('user@acme.com', 'pw')).resolves.toBeNull();
  });

  it('returns null when JWT from platform is missing organizationId', async () => {
    const platformJwt = signPlatformJwt({ sub: 'user-9' });
    mockAxios.post.mockResolvedValueOnce({ status: 200, data: { accessToken: platformJwt } });
    await expect(resolveIdentityWithPlatform('user@acme.com', 'pw')).resolves.toBeNull();
  });
});
