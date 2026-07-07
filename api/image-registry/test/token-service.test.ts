// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createPublicKey, X509Certificate } from 'crypto';

// A fixed RSA keypair + matching self-signed x509 cert (generated once with openssl,
// embedded so the test needs no external tools at runtime). We use a REAL certificate
// — not a bare public key — for REGISTRY_TOKEN_CERTIFICATE so the `x5c` header is
// genuine base64 DER and the assertion below exercises the registry-v3 cert path
// (certsToX5c throws on a non-cert PEM). The public key derived from the cert verifies
// the token signatures.
const privateKeyPem = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC/uvorjR4hVMJv
0MxdyyGAj8woPBqga+8pYMRt/k693LuUZujtl32SPSQVVRYjzOGgvn5gF5lMoYkh
WMiSpkqgnQXS4ylnyfNxJLNsQFhyae2+lzh1fvrORCLo5ahIxRaEe53ZDlFzmWk8
jUxn6hB/Uj4AxryyOyfJBIXSgGcBiTYEy7qbPOtIRltu06V8gFq9AwzeTHQ8TtLL
/rlsw6WvdEqBui4FtA7sgt6AyetWEp/HU8u85U9apML4dZm4c0ljUa8BtP3ZxnPt
Ph/vJn2RXGk2OZoeZCN4o79etxSMPxYVZz/amJBnEWUfdCn6ZfZUjrSkGvDHq0q5
NNMmahQ9AgMBAAECggEACc8eLUa6Z9BPOfXCfY+e0+s8xxfbcTbRxPnsAB2ejS+j
EtKuBY52e0TGA70MlYHN+abtTmtpVCaVM7Uis9VZTud3Ag+i/BSfWrvwMwWwELsd
0Z5TzOJqy00976Y6P8OCOqkcDbFiFj+JxweKmmwQR9dJup6a+Ppg93OUCM2OwjZa
be6YimPqS29OddqLP2bhAoGykLcW2hmHzDcXC7rHyG7nR37/qIWJwY3PqLFkOmwB
tcU1YBjjQCC9fr2YbJdXKWJQoktB7BKRQY+mGBh5JMHKoFS7hc43hzN96CcZVlEG
vFYlnqlcwqzA981Mbk48yU1OwCERPZsOfzdv/EbNSQKBgQDqj3P3m3X4hNk12EZ/
+1WUDjk1Zb0cOKJoRU4BbZtIu3BoRMk2piEzfXj6LM4gGGScqIvA4hagdLiiSe+h
LauMcnkSpHhmA8AaH3E4dTGFDQx0b9dDTKu9UCto39bYV5nBdvIV18C3E91T77tV
6aojwFv153gqQNAfDJfUJ4NAKQKBgQDRQVU0vqcaG8n/iKRwTSFae4CsJEz5/6LH
OTVih1f+IkN34B1o/tWJCYL00DQYrPAKLKBXXGgUGCsvP0qdN8j8IuPSAwknZwX5
y33eXZSy5GfTK8Og3u+vD5WXYH50iLTZ8gbj+SkeRh1Iz3+zIX/CP9khQq9IGD0G
tkh460Hl9QKBgAW5+trQsNCgba0i2pXFTRGQR1VGZpeJym1BQ+ZFBsV/zf69ryvm
YmkfZxS0g1PFRK+ObdsHqgXA08EijPciZk3Hfa021rmm3cnFer4mHk9hQiyVjmvW
M1sr2eN1k4k0mkxe2wotekb99SlXcPtn+P9mcthODmD5tBsN86b6T/oBAoGAS8s4
S6SK7kAGiJI7zZmCbT2yu6diYmMf2L12Arw3OQu8GF2LCY7UVZCmaHpJhG6Pe3/y
i/IimLSwX6qzIgMkv377ugPzetwsI/B7JOIMjEeC+9AsSca2Vlh0vKHs69TgfNjX
eheztw16afcOsBmAJyHtScjXqGtvH1FDKtk7w0kCgYBixxwzrvcnvv1iC36CqFL8
ClLvJeLqs7H+vc2ggYAAnhg9LkJ3GX0Ocuybxt9dM4AlBhn1IVZ6kwcLLjAPezl5
un92mzJiPgBVKAPVWbZZ4UarqXn8ATLRAxNOT6sM+oTaVjUcXgxB+Soth+RPUIge
YJnkbFG6JS+bq8O5+N3VSQ==
-----END PRIVATE KEY-----
`;
const certPem = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUIoW3p/W0frI6Fsx94GJw3O1kiGowDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwccGlwZWxpbmUtaW1hZ2UtcmVnaXN0cnktdGVzdDAeFw0y
NjA2MTIxNDIyMjNaFw0zNjA2MDkxNDIyMjNaMCcxJTAjBgNVBAMMHHBpcGVsaW5l
LWltYWdlLXJlZ2lzdHJ5LXRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQC/uvorjR4hVMJv0MxdyyGAj8woPBqga+8pYMRt/k693LuUZujtl32SPSQV
VRYjzOGgvn5gF5lMoYkhWMiSpkqgnQXS4ylnyfNxJLNsQFhyae2+lzh1fvrORCLo
5ahIxRaEe53ZDlFzmWk8jUxn6hB/Uj4AxryyOyfJBIXSgGcBiTYEy7qbPOtIRltu
06V8gFq9AwzeTHQ8TtLL/rlsw6WvdEqBui4FtA7sgt6AyetWEp/HU8u85U9apML4
dZm4c0ljUa8BtP3ZxnPtPh/vJn2RXGk2OZoeZCN4o79etxSMPxYVZz/amJBnEWUf
dCn6ZfZUjrSkGvDHq0q5NNMmahQ9AgMBAAGjUzBRMB0GA1UdDgQWBBQyqTJclUMN
9e7SbSxlIM4izd8lWDAfBgNVHSMEGDAWgBQyqTJclUMN9e7SbSxlIM4izd8lWDAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCFkqUk/0ztTKSwN38z
1WdcMKCGUTi1TlBqPKiFhWIdFA5GreAI8AS3B3DRgFaDpnH/mc17iYmJB4LcJJ6r
qQm20VpipNm6y5d6Tcy+DvmP8s+1n8SYbG/Z2XAml4uOLh1WX7OVj/JoP/34NUPu
ANzOxfLl1430qwBcpcXqdF/BVmJn9Z4ekq/Z/CjcBf1EBVGKSHRpp6bbHKgUUH5E
klG0KIX9XwOCxWkdutHR/uKzXoquWBO1dQ02W6Q9x+hKHmi/V0wtDlATi5MHdosx
rzOZmOFBeXYrkwSUTtzfL8JfllcmQ3g3sY/lSk9yazPaqKpBTYspjB07/iMXbWdN
7mYv
-----END CERTIFICATE-----
`;
const publicKeyPem = createPublicKey(certPem).export({ format: 'pem', type: 'spki' }).toString();

process.env.IMAGE_REGISTRY_HOST = 'localhost';
process.env.IMAGE_REGISTRY_USERNAME = 'test-svc';
process.env.IMAGE_REGISTRY_PASSWORD = 'test-pw';
process.env.REGISTRY_TOKEN_PRIVATE_KEY = privateKeyPem;
process.env.REGISTRY_TOKEN_CERTIFICATE = certPem;
process.env.REGISTRY_TOKEN_ISSUER = 'test-platform';
process.env.REGISTRY_TOKEN_SERVICE = 'test-registry';
process.env.JWT_SECRET = 'test-jwt-secret';

import { jest, describe, it, expect } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { apiCoreMock } from './helpers/mock-api-core.js';

// @pipeline-builder/api-core ships as CommonJS under a `type: module` package,
// so its named exports don't resolve under jest's ESM loader. Mock the few
// exports token-service uses. createQuotaService's `check` resolves an
// unlimited storage limit (-1) so the storage push-gate is a no-op — matching
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
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false },
      { type: 'repository', name: 'system/cdk-synth', actions: ['pull'] },
    );
    expect(granted).toEqual(['pull']);
  });

  it('denies push on system/* to non-admin JWT', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false },
      { type: 'repository', name: 'system/cdk-synth', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull']);
  });

  it('grants pull,push on system/* to a SYSTEM-ORG token (system sample-plugin build)', () => {
    // The system org owns system/*; a system-org-scoped build token (not a
    // super-admin) must be able to push its sample plugins there.
    const granted = authorizeScope( { type: 'jwt', orgId: 'system', userId: 'svc-plugin', isAdmin: false, isSuperAdmin: false },
      { type: 'repository', name: 'system/sentry-release', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull', 'push']);
  });

  it('does NOT let the system-org token push outside system/* (e.g. library/* or another org)', () => {
    const lib = authorizeScope( { type: 'jwt', orgId: 'system', userId: 'svc-plugin', isAdmin: false, isSuperAdmin: false },
      { type: 'repository', name: 'library/ubuntu', actions: ['pull', 'push'] },
    );
    expect(lib).toEqual(['pull']); // library/* push stays super-admin-only
    const other = authorizeScope( { type: 'jwt', orgId: 'system', userId: 'svc-plugin', isAdmin: false, isSuperAdmin: false },
      { type: 'repository', name: 'org-acme/foo', actions: ['pull', 'push'] },
    );
    expect(other).toEqual([]); // system org has no claim on a tenant namespace
  });

  it('grants pull,push on org-{orgId}/* to matching JWT', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false },
      { type: 'repository', name: 'org-acme/my-plugin', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull', 'push']);
  });

  it('denies access to a different orgs repo for non-admin', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false },
      { type: 'repository', name: 'org-other/their-plugin', actions: ['pull'] },
    );
    expect(granted).toEqual([]);
  });

  it('grants super-admin pull,push on any org-prefix repo', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: true, isSuperAdmin: true },
      { type: 'repository', name: 'org-other/foo', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull', 'push']);
  });

  it('grants super-admin push on system/* (bootstrap base-image push)', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'system', userId: 'bootstrap-push', isAdmin: true, isSuperAdmin: true },
      { type: 'repository', name: 'system/cdk-synth', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull', 'push']);
  });

  it('denies an ORG admin (isAdmin, not super-admin) push into another orgs repo', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: true, isSuperAdmin: false },
      { type: 'repository', name: 'org-other/foo', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual([]);
  });

  it('denies an ORG admin (isAdmin, not super-admin) push to system/* (pull only)', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: true, isSuperAdmin: false },
      { type: 'repository', name: 'system/cdk-synth', actions: ['pull', 'push'] },
    );
    expect(granted).toEqual(['pull']);
  });

  it('still grants an org admin pull,push on their OWN org namespace', () => {
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: true, isSuperAdmin: false },
      { type: 'repository', name: 'org-acme/my-plugin', actions: ['pull', 'push'] },
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
    const granted = authorizeScope( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: true, isSuperAdmin: true },
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
    const result = await authorizeAndIssue( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false },
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

    // registry v3: the JWT header carries the x5c cert chain — each entry genuine
    // base64-DER that parses as an x509 cert — and NOT the old libtrust kid (which v3
    // rejects as an untrusted key).
    const header = (jwt.decode(result.token, { complete: true }) as { header: { x5c?: string[] } }).header;
    expect(Array.isArray(header.x5c)).toBe(true);
    expect(header.x5c).toHaveLength(1);
    expect(() => new X509Certificate(Buffer.from(header.x5c![0], 'base64'))).not.toThrow();
    expect(header).not.toHaveProperty('kid');
  });

  it('omits scopes that fully fail authorization', async () => {
    const result = await authorizeAndIssue( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false },
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
    const result = await authorizeAndIssue( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false },
      [{ type: 'repository', name: 'org-other/foo', actions: ['pull'] }],
      'u1',
    );
    const decoded = jwt.verify(result.token, publicKeyPem, { algorithms: ['RS256'] }) as unknown as {
      access: unknown[];
    };
    expect(decoded.access).toEqual([]);
  });

  it('issues a token even with no requested scopes (docker login probe)', async () => {
    const result = await authorizeAndIssue( { type: 'jwt', orgId: 'acme', userId: 'u1', isAdmin: false, isSuperAdmin: false },
      [],
      'u1',
    );
    const decoded = jwt.verify(result.token, publicKeyPem, { algorithms: ['RS256'] }) as unknown as {
      access: unknown[];
    };
    expect(decoded.access).toEqual([]);
  });
});
