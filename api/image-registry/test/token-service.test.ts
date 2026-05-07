// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync } from 'crypto';

// Generate a test keypair before importing config / token-service so the
// service picks them up at module load.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

// We can't easily generate an x509 cert here without external tools, so we
// use the public key PEM directly — the kid computation only needs the
// public key, not a wrapping cert. For tests, certificatePem is treated as
// a public-key bundle (createPublicKey accepts both forms).
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.IMAGE_REGISTRY_USERNAME = 'test-svc';
process.env.IMAGE_REGISTRY_PASSWORD = 'test-pw';
process.env.REGISTRY_TOKEN_PRIVATE_KEY = privateKeyPem;
process.env.REGISTRY_TOKEN_CERTIFICATE = publicKeyPem;
process.env.REGISTRY_TOKEN_ISSUER = 'test-platform';
process.env.REGISTRY_TOKEN_SERVICE = 'test-registry';
process.env.JWT_SECRET = 'test-jwt-secret';

import jwt from 'jsonwebtoken';
import {
  parseScope,
  authorizeScope,
  authorizeAndIssue,
} from '../src/services/token-service';

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
    const granted = authorizeScope(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      { type: 'repository', name: 'system/cdk-synth', actions: ['pull'] },
    );
    expect(granted).toEqual(['pull']);
  });

  it('denies push on system/* to non-admin JWT', () => {
    const granted = authorizeScope(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      { type: 'repository', name: 'system/cdk-synth', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull']);
  });

  it('grants pull,push on org-{orgId}/* to matching JWT', () => {
    const granted = authorizeScope(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      { type: 'repository', name: 'org-acme/my-plugin', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull', 'push']);
  });

  it('denies access to a different orgs repo for non-admin', () => {
    const granted = authorizeScope(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      { type: 'repository', name: 'org-other/their-plugin', actions: ['pull'] },
    );
    expect(granted).toEqual([]);
  });

  it('grants admin pull,push on any org-prefix repo', () => {
    const granted = authorizeScope(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: true },
      { type: 'repository', name: 'org-other/foo', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull', 'push']);
  });

  it('grants management whatever it requests on any scope type', () => {
    const granted = authorizeScope(
      { type: 'management' },
      { type: 'repository', name: 'system/synth', actions: ['pull', 'push', '*'] },
    );
    expect(granted).toEqual(['pull', 'push', '*']);
  });

  it('grants management access on registry:catalog scope (used by registry-client)', () => {
    const granted = authorizeScope(
      { type: 'management' },
      { type: 'registry', name: 'catalog', actions: ['*'] },
    );
    expect(granted).toEqual(['*']);
  });

  it('rejects non-repository scope types for external identities', () => {
    const granted = authorizeScope(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: true },
      { type: 'unknown', name: 'foo', actions: ['pull'] },
    );
    expect(granted).toEqual([]);
  });
});

describe('authorizeAndIssue', () => {
  it('mints a JWT signed with the configured key', () => {
    const token = authorizeAndIssue(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      [{ type: 'repository', name: 'org-acme/foo', actions: ['pull', 'push'] }],
      'u1',
    );
    expect(typeof token).toBe('string');

    const decoded = jwt.verify(token, publicKeyPem, {
      algorithms: ['RS256'],
      issuer: 'test-platform',
      audience: 'test-registry',
    }) as { sub: string; access: Array<{ name: string; actions: string[] }> };

    expect(decoded.sub).toBe('acme:u1');
    expect(decoded.access).toEqual([
      { type: 'repository', name: 'org-acme/foo', actions: ['pull', 'push'] },
    ]);
  });

  it('omits scopes that fully fail authorization', () => {
    const token = authorizeAndIssue(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      [
        { type: 'repository', name: 'org-acme/foo', actions: ['pull'] },
        { type: 'repository', name: 'org-other/bar', actions: ['pull'] },
      ],
      'u1',
    );
    const decoded = jwt.verify(token, publicKeyPem, { algorithms: ['RS256'] }) as {
      access: Array<{ name: string }>;
    };
    expect(decoded.access).toHaveLength(1);
    expect(decoded.access[0].name).toBe('org-acme/foo');
  });

  it('issues an empty-access token when nothing is authorized', () => {
    const token = authorizeAndIssue(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      [{ type: 'repository', name: 'org-other/foo', actions: ['pull'] }],
      'u1',
    );
    const decoded = jwt.verify(token, publicKeyPem, { algorithms: ['RS256'] }) as {
      access: unknown[];
    };
    expect(decoded.access).toEqual([]);
  });

  it('issues a token even with no requested scopes (docker login probe)', () => {
    const token = authorizeAndIssue(
      { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false },
      [],
      'u1',
    );
    const decoded = jwt.verify(token, publicKeyPem, { algorithms: ['RS256'] }) as {
      access: unknown[];
    };
    expect(decoded.access).toEqual([]);
  });
});
