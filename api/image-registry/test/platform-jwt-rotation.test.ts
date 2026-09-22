// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rotation drill for the signing keys as seen by image-registry
 * (docs/runbooks/secret-rotation.md).
 *
 * This service verifies platform tokens on the `/token` mint path — the creds
 * customer CodeBuild and the plugin-lookup Lambda read out of Secrets Manager,
 * and the service token `api/plugin` presents for its own image pushes. Two
 * chains meet here, so both rotations are drilled:
 *
 * - a USER token is ES256 and rotates by `kid` (the retiring key stays
 *   published in the JWKS); without that overlap a rotation 401s every
 *   in-flight `docker pull`/`push`.
 * - an internal SERVICE token is ES256 signed by the CALLING service with its
 *   own key and rotates by `kid` too — the retiring key stays published in
 *   the shared per-service bundle for the overlap.
 *
 * And the boundary between them: a token on the wrong chain must not mint
 * registry credentials — neither an HS256 token claiming to be a user (which
 * this service used to accept) nor a service token signed by the wrong service.
 */

import { generateKeyPairSync } from 'crypto';
import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import {
  installTestServiceKeys,
  type TestServiceKeysHandle,
  generateTestSigningKey,
  installTestJwks,
  signTestUserToken,
  testUserIdentityClaims,
  type TestSigningKey,
} from '@pipeline-builder/api-core/testing';
import jwt from 'jsonwebtoken';
import { apiCoreMock } from './helpers/mock-api-core.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.REGISTRY_TOKEN_PRIVATE_KEY = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
process.env.REGISTRY_TOKEN_CERTIFICATE = publicKey.export({ format: 'pem', type: 'spki' }).toString();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('axios', () => ({
  // The `docker login` fallback path must never be what rescues these cases.
  default: { post: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('platform unreachable')) },
}));

/** Load the resolver fresh (config reads env at import). */
async function loadResolver() {
  jest.resetModules();
  const mod = await import('../src/services/auth-resolver.js');
  return mod.resolveIdentity;
}

const userToken = (key: TestSigningKey, extra: Record<string, unknown> = {}) =>
  signTestUserToken(
    { ...testUserIdentityClaims(), sub: 'user-1', role: 'member', organizationId: 'acme', ...extra },
    { key, expiresIn: 600 },
  );

let incoming: TestSigningKey;
let retiring: TestSigningKey;
let serviceKeys: TestServiceKeysHandle;

beforeEach(() => {
  incoming = generateTestSigningKey();
  retiring = generateTestSigningKey();
  // Real per-service key files, as the deploy writes them. `plugin-next` stands
  // in for plugin's INCOMING key during a rotation; `evil` is any other service
  // that holds a valid key of its own.
  serviceKeys?.uninstall();
  serviceKeys = installTestServiceKeys(['plugin', 'plugin-next', 'evil']);
  serviceKeys.publish(['plugin', 'evil']);
});
afterAll(() => serviceKeys?.uninstall());

/** A well-formed internal token from `plugin`, as that service's process mints it. */
const serviceToken = (extra: Record<string, unknown> = {}, expiresInSeconds = 600) =>
  serviceKeys.sign('plugin', { organizationId: 'acme', ...extra }, expiresInSeconds);

describe('user-token signing-key rotation', () => {
  it('old-signed token: accepted while its kid is published, rejected once it is dropped', async () => {
    installTestJwks([retiring]);
    const oldToken = await userToken(retiring);

    // — before rotation.
    expect(await (await loadResolver())('orgname', oldToken)).toMatchObject({ orgId: 'acme', userId: 'user-1' });

    // — overlap: platform signs with `incoming`, publishes both.
    installTestJwks([incoming, retiring]);
    let resolve = await loadResolver();
    expect(await resolve('orgname', oldToken)).toMatchObject({ orgId: 'acme' });
    expect(await resolve('orgname', await userToken(incoming, { sub: 'user-2' }))).toMatchObject({ userId: 'user-2' });

    // — finished: the retiring kid no longer mints registry creds.
    installTestJwks([incoming]);
    resolve = await loadResolver();
    expect(await resolve('orgname', oldToken)).toBeNull();
    expect(await resolve('orgname', await userToken(incoming))).toMatchObject({ orgId: 'acme' });
  });

  it('a published kid neither revives an expired token nor admits an unpublished key', async () => {
    installTestJwks([incoming]);
    const resolve = await loadResolver();
    const expired = await userToken(incoming, { exp: Math.floor(Date.now() / 1000) - 5 });
    expect(await resolve('orgname', expired)).toBeNull();
    expect(await resolve('orgname', await userToken(generateTestSigningKey()))).toBeNull();
  });

  it('REFUSES an HS256 token that claims to be a user — it can no longer mint registry creds', async () => {
    // Before the asymmetric-signing cutover this service held `JWT_SECRET` and
    // this token was indistinguishable from a real platform-minted one.
    installTestJwks([incoming]);
    const resolve = await loadResolver();
    const forged = jwt.sign(
      { ...testUserIdentityClaims(), sub: 'user-1', role: 'owner', organizationId: 'acme', isSuperAdmin: true },
      'any-shared-secret',
      { expiresIn: 600 },
    );
    expect(await resolve('orgname', forged)).toBeNull();
  });
});

describe('service signing-key rotation', () => {
  it('old-signed service token: accepted while its key is published, rejected once it is dropped', async () => {
    installTestJwks([incoming]);
    const oldToken = serviceToken();

    // Overlap: the bundle publishes plugin's retiring key alongside the incoming one.
    serviceKeys.publishKeys({
      plugin: [serviceKeys.keys.get('plugin')!, serviceKeys.keys.get('plugin-next')!],
      evil: [serviceKeys.keys.get('evil')!],
    });
    let resolve = await loadResolver();
    expect(await resolve('orgname', oldToken)).toMatchObject({ orgId: 'acme', userId: 'service:plugin' });

    // Finished: the retiring key is dropped, so tokens it signed stop working.
    serviceKeys.publishKeys({ plugin: [serviceKeys.keys.get('plugin-next')!], evil: [serviceKeys.keys.get('evil')!] });
    resolve = await loadResolver();
    expect(await resolve('orgname', oldToken)).toBeNull();
  });

  it('REFUSES a token signed by a DIFFERENT service than its subject names', async () => {
    installTestJwks([incoming]);
    const resolve = await loadResolver();
    expect(await resolve('orgname', serviceKeys.signAs('evil', 'plugin', { organizationId: 'acme' }))).toBeNull();
  });

  it('REFUSES an expired service token, and an HS256 one whatever secret signed it', async () => {
    installTestJwks([incoming]);
    const resolve = await loadResolver();
    expect(await resolve('orgname', serviceToken({}, -5))).toBeNull();
    const hs256 = jwt.sign(
      { type: 'access', sub: 'service:plugin', principalType: 'service', token_use: 'access', role: 'member', organizationId: 'acme' },
      'any-shared-secret',
      { expiresIn: 600 },
    );
    expect(await resolve('orgname', hs256)).toBeNull();
  });
});
