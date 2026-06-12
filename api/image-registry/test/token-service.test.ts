// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from 'crypto';

// Generate a test keypair before importing config / token-service so the
// service picks them up at module load.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

// We can't easily generate an x509 cert here without external tools, so we use
// the public key PEM as a stand-in for REGISTRY_TOKEN_CERTIFICATE. The token's
// x5c header is therefore not a real DER cert in this unit test — the registry-v3
// path (a real openssl cert verified against the registry's rootcertbundle) is
// what exercises that end-to-end. Here we only assert the header SHAPE below.
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.IMAGE_REGISTRY_USERNAME = 'test-svc';
process.env.IMAGE_REGISTRY_PASSWORD = 'test-pw';
process.env.REGISTRY_TOKEN_PRIVATE_KEY = privateKeyPem;
process.env.REGISTRY_TOKEN_CERTIFICATE = publicKeyPem;
process.env.REGISTRY_TOKEN_ISSUER = 'test-platform';
process.env.REGISTRY_TOKEN_SERVICE = 'test-registry';
process.env.JWT_SECRET = 'test-jwt-secret';

import { jest, describe, it, expect } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { apiCoreMock } from './helpers/mock-api-core.js';

// @pipeline-builder/api-core ships as CommonJS under a `type: module` package,
// so its named exports don't resolve under jest's ESM loader. Mock the few
// exports token-service uses. createQuotaService's `check` resolves an
// unlimited tier (limit: -1) so the storage push-gate is a no-op — matching
// the fail-open behaviour the original (unmocked) test relied on.
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createQuotaService: () => ({
    check: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ limit: -1 }),
  }),
  getServiceAuthHeader: jest.fn<(...args: unknown[]) => string>().mockReturnValue('Bearer test'),
}));

const {
  parseScope,
  authorizeScope,
  authorizeAndIssue,
} = await import('../src/services/token-service.js');

describe('parseScope', () => {
  it('parses simple repo:name:actions', () => {
    expect(parseScope('repository:foo:pull')).toEqual({
      type: 'repository',
      name: 'foo',
      actions: ['pull'],
    });
  });

  it('parses multi-action', () => {
    expect(parseScope('repository:foo:pull,push')).toEqual({
      type: 'repository',
      name: 'foo',
      actions: ['pull', 'push'],
    });
  });

  it('preserves slashes in repo name', () => {
    expect(parseScope('repository:org-acme/foo:pull')).toEqual({
      type: 'repository',
      name: 'org-acme/foo',
      actions: ['pull'],
    });
  });

  it('returns null for malformed scope', () => {
    expect(parseScope('not-a-scope')).toBeNull();
    expect(parseScope('repository:noActions:')).toBeNull();
    expect(parseScope('::')).toBeNull();
  });
});

describe('authorizeScope', () => {
  it('grants pull on system/* to JWT identity', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      { type: 'repository', name: 'system/cdk-synth', actions: ['pull'] },
    );
    expect(granted).toEqual(['pull']);
  });

  it('denies push on system/* to non-admin JWT', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      { type: 'repository', name: 'system/cdk-synth', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull']);
  });

  it('grants pull,push on org-{orgId}/* to matching JWT', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      { type: 'repository', name: 'org-acme/my-plugin', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull', 'push']);
  });

  it('denies access to a different orgs repo for non-admin', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      { type: 'repository', name: 'org-other/their-plugin', actions: ['pull'] },
    );
    expect(granted).toEqual([]);
  });

  it('grants admin pull,push on any org-prefix repo', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: true },
      { type: 'repository', name: 'org-other/foo', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull', 'push']);
  });

  it('grants management whatever it requests on any scope type', () => {
    const granted = authorizeScope( { type: 'management' },
      { type: 'repository', name: 'system/synth', actions: ['pull', 'push', '*'] },
    );
    expect(granted).toEqual(['pull', 'push', '*']);
  });

  it('grants management access on registry:catalog scope (used by registry-client)', () => {
    const granted = authorizeScope( { type: 'management' },
      { type: 'registry', name: 'catalog', actions: ['*'] },
    );
    expect(granted).toEqual(['*']);
  });

  it('rejects non-repository scope types for external identities', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: true },
      { type: 'unknown', name: 'foo', actions: ['pull'] },
    );
    expect(granted).toEqual([]);
  });
});

// authorizeAndIssue is async  the push-gate calls quotaService.check
// + computeStorageUsage. With no quota service reachable in tests it
// fail-opens, but the call still requires an await.
describe('authorizeAndIssue', () => {
  it('mints a JWT signed with the configured key', async () => {
    const result = await authorizeAndIssue( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      [{ type: 'repository', name: 'org-acme/foo', actions: ['pull', 'push'] }],
      'u1',
    );
    expect(typeof result.token).toBe('string');
    expect(result.accessCount).toBe(1);

    const decoded = jwt.verify(result.token, publicKeyPem, {
      algorithms: ['RS256'],
      issuer: 'test-platform',
      audience: 'test-registry',
    }) as unknown as { sub: string; access: Array<{ name: string; actions: string[] }> };

    expect(decoded.sub).toBe('acme:u1');
    expect(decoded.access).toEqual([
      { type: 'repository', name: 'org-acme/foo', actions: ['pull', 'push'] },
    ]);

    // registry v3: the JWT header must carry the x5c cert chain, and must NOT
    // carry the old libtrust kid (which v3 rejects as an untrusted key).
    const header = (jwt.decode(result.token, { complete: true }) as { header: Record<string, unknown> }).header;
    expect(Array.isArray(header.x5c)).toBe(true);
    expect(header.x5c).toHaveLength(1);
    expect(header).not.toHaveProperty('kid');
  });

  it('omits scopes that fully fail authorization', async () => {
    const result = await authorizeAndIssue( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      [
        { type: 'repository', name: 'org-acme/foo', actions: ['pull'] },
        { type: 'repository', name: 'org-other/bar', actions: ['pull'] },
      ],
      'u1',
    );
    const decoded = jwt.verify(result.token, publicKeyPem, { algorithms: ['RS256'] }) as unknown as {
      access: Array<{ name: string }>;
    };
    expect(decoded.access).toHaveLength(1);
    expect(decoded.access[0].name).toBe('org-acme/foo');
  });

  it('issues an empty-access token when nothing is authorized', async () => {
    const result = await authorizeAndIssue( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      [{ type: 'repository', name: 'org-other/foo', actions: ['pull'] }],
      'u1',
    );
    const decoded = jwt.verify(result.token, publicKeyPem, { algorithms: ['RS256'] }) as unknown as {
      access: unknown[];
    };
    expect(decoded.access).toEqual([]);
  });

  it('issues a token even with no requested scopes (docker login probe)', async () => {
    const result = await authorizeAndIssue( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      [],
      'u1',
    );
    const decoded = jwt.verify(result.token, publicKeyPem, { algorithms: ['RS256'] }) as unknown as {
      access: unknown[];
    };
    expect(decoded.access).toEqual([]);
  });
});
