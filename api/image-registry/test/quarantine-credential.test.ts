// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The quarantine build credential (E21): minted for ONE submission, resolved by
 * the token endpoint to an identity that reaches `quarantine/<thatId>` (and
 * base-image pulls) and nothing else; forged, expired or foreign-audience
 * tokens are not quarantine credentials. Plus the team parent-pull set (E22).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import jwt from 'jsonwebtoken';

import { apiCoreMock } from './helpers/mock-api-core.js';
import { TOKEN_SIGNING_CERT_PEM, TOKEN_SIGNING_PRIVATE_KEY_PEM } from './helpers/token-signing-fixture.js';

process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.REGISTRY_TOKEN_PRIVATE_KEY = TOKEN_SIGNING_PRIVATE_KEY_PEM;
process.env.REGISTRY_TOKEN_CERTIFICATE = TOKEN_SIGNING_CERT_PEM;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: () => ({ check: jest.fn<(...a: unknown[]) => Promise<unknown>>().mockResolvedValue({ limit: -1 }) }),
  getServiceAuthHeader: jest.fn<(...a: unknown[]) => string>().mockReturnValue('Bearer test'),
}));

const { mintQuarantineCredential, verifyQuarantineCredential, QUARANTINE_CREDENTIAL_MAX_TTL_SECONDS } = await import('../src/services/quarantine-credential.js');
const { resolveIdentity } = await import('../src/services/auth-resolver.js');
const { authorizeAndIssue } = await import('../src/services/token-service.js');
const { setParentPublicPluginsFetcherForTests } = await import('../src/services/parent-public-plugins.js');

const SUB = '0f3a2b1c-aaaa-4bbb-8ccc-123456789abc';

const accessOf = (token: string) =>
  (jwt.verify(token, TOKEN_SIGNING_CERT_PEM, { algorithms: ['RS256'] }) as unknown as { access: unknown[] }).access;

describe('quarantine build credential', () => {
  it('round-trips: mint → the token endpoint resolves it to that submission only', async () => {
    const cred = await mintQuarantineCredential(SUB, 900);
    expect(cred.username).toBe('_quarantine');
    expect(await verifyQuarantineCredential(cred.password)).toBe(SUB);
    const identity = await resolveIdentity(cred.username, cred.password);
    expect(identity).toEqual({ type: 'quarantine', submissionId: SUB });

    const { token } = await authorizeAndIssue(identity!, [
      { type: 'repository', name: `quarantine/${SUB}`, actions: ['pull', 'push'] },
      { type: 'repository', name: 'quarantine/someone-else', actions: ['pull', 'push'] },
      { type: 'repository', name: 'library/alpine', actions: ['pull'] },
      { type: 'repository', name: 'org-acme/app', actions: ['pull'] },
    ], cred.username);
    expect(accessOf(token)).toEqual([
      { type: 'repository', name: `quarantine/${SUB}`, actions: ['pull', 'push'] },
      { type: 'repository', name: 'library/alpine', actions: ['pull'] },
    ]);
  });

  it('clamps the lifetime', async () => {
    const long = await mintQuarantineCredential(SUB, 10 * 24 * 3600);
    const { exp, iat } = jwt.decode(long.password) as { exp: number; iat: number };
    expect(exp - iat).toBe(QUARANTINE_CREDENTIAL_MAX_TTL_SECONDS);
  });

  it('is not a quarantine credential when forged, expired, or minted for another audience', async () => {
    const other = jwt.sign({ sub: `quarantine:${SUB}`, submissionId: SUB }, TOKEN_SIGNING_PRIVATE_KEY_PEM, { algorithm: 'RS256', audience: 'pipeline-image-registry', issuer: 'platform', expiresIn: 60 });
    expect(await verifyQuarantineCredential(other)).toBeNull();
    const expired = jwt.sign({ sub: `quarantine:${SUB}`, submissionId: SUB }, TOKEN_SIGNING_PRIVATE_KEY_PEM, { algorithm: 'RS256', audience: 'pb-quarantine-build', issuer: 'platform', expiresIn: -10 });
    expect(await verifyQuarantineCredential(expired)).toBeNull();
    const mismatched = jwt.sign({ sub: 'quarantine:other', submissionId: SUB }, TOKEN_SIGNING_PRIVATE_KEY_PEM, { algorithm: 'RS256', audience: 'pb-quarantine-build', issuer: 'platform', expiresIn: 60 });
    expect(await verifyQuarantineCredential(mismatched)).toBeNull();
    const { privateKey } = await import('crypto').then((c) => c.generateKeyPairSync('rsa', { modulusLength: 2048 }));
    const forged = jwt.sign({ sub: `quarantine:${SUB}`, submissionId: SUB }, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), { algorithm: 'RS256', audience: 'pb-quarantine-build', issuer: 'platform', expiresIn: 60 });
    expect(await verifyQuarantineCredential(forged)).toBeNull();
    expect(await verifyQuarantineCredential('not-a-jwt')).toBeNull();
  });

  it('refuses to mint for a malformed submission id', async () => {
    await expect(mintQuarantineCredential('../etc', 60)).rejects.toThrow(/Invalid submission id/);
  });
});

describe('team pulls of the parent namespace (E22)', () => {
  const team = { type: 'jwt' as const, orgId: 'acme-team', parentOrgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false, canWritePlugins: false };
  let calls: string[];

  beforeEach(() => { calls = []; });

  it('grants pull only on the parent\'s PUBLIC plugins, read once from the plugin service and cached', async () => {
    setParentPublicPluginsFetcherForTests(async (orgId) => { calls.push(orgId); return ['shared']; });
    const scopes = [
      { type: 'repository', name: 'org-acme/shared', actions: ['pull', 'push'] },
      { type: 'repository', name: 'org-acme/private-tool', actions: ['pull'] },
    ];
    expect(accessOf((await authorizeAndIssue(team, scopes, 'u1')).token)).toEqual([{ type: 'repository', name: 'org-acme/shared', actions: ['pull'] }]);
    await authorizeAndIssue(team, scopes, 'u1');
    expect(calls).toEqual(['acme']);
  });

  it('fails closed when the public set cannot be read', async () => {
    setParentPublicPluginsFetcherForTests(async () => { throw new Error('plugin down'); });
    const { token } = await authorizeAndIssue(team, [{ type: 'repository', name: 'org-acme/shared', actions: ['pull'] }], 'u1');
    expect(accessOf(token)).toEqual([]);
  });

  it('never asks when no parent repository is requested', async () => {
    setParentPublicPluginsFetcherForTests(async (orgId) => { calls.push(orgId); return []; });
    await authorizeAndIssue(team, [{ type: 'repository', name: 'org-acme-team/mine', actions: ['pull'] }], 'u1');
    expect(calls).toEqual([]);
  });
});
