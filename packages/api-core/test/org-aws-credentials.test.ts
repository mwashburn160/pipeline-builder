// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for OrgAwsCredentialsManager. Covers per-org provider selection,
 * fallback for orgs without config, in-flight coalescing, evict semantics,
 * and that the AssumeRole parameters (RoleArn, ExternalId, session name,
 * duration) are wired through correctly to the underlying SDK.
 */

import type { OrgAwsConfig } from '../src/utils/org-aws-credentials';

// Capture the exact call args fromTemporaryCredentials sees so we can
// assert the AssumeRole parameters are wired correctly. The provider
// returned by the mock is a no-op stub credential factory — we never
// actually invoke STS here.
const fromTempCalls: unknown[] = [];
const fallbackCalls = { count: 0 };

beforeEach(() => {
  jest.resetModules();
  fromTempCalls.length = 0;
  fallbackCalls.count = 0;
  jest.doMock('@aws-sdk/credential-providers', () => ({
    fromTemporaryCredentials: jest.fn((args) => {
      fromTempCalls.push(args);
      // Return a provider tagged with the role so tests can assert which
      // org got which provider.
      const stub = async () => ({
        accessKeyId: `AKIA-${args.params?.RoleArn || 'X'}`,
        secretAccessKey: 'secret',
        sessionToken: 'session',
        expiration: new Date(Date.now() + 3_600_000),
      });
      (stub as unknown as { __roleArn: string }).__roleArn = args.params?.RoleArn || '';
      return stub;
    }),
    fromNodeProviderChain: jest.fn(() => {
      const stub = async () => {
        fallbackCalls.count++;
        return {
          accessKeyId: 'AKIA-FALLBACK',
          secretAccessKey: 'secret',
        };
      };
      (stub as unknown as { __fallback: boolean }).__fallback = true;
      return stub;
    }),
  }));
  jest.doMock('@aws-sdk/client-sts', () => ({
    STSClient: jest.fn(),
  }));
});

afterEach(() => {
  jest.dontMock('@aws-sdk/credential-providers');
  jest.dontMock('@aws-sdk/client-sts');
});

describe('OrgAwsCredentialsManager', () => {
  it('falls back to the default chain for orgs with no per-org config', async () => {
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver: async () => null });

    const provider = await manager.getCredentials('org-x');
    const creds = await provider();
    expect(creds.accessKeyId).toBe('AKIA-FALLBACK');
    expect(fromTempCalls).toHaveLength(0);
  });

  it('uses fromTemporaryCredentials with the configured RoleArn + ExternalId for orgs with config', async () => {
    const cfg: OrgAwsConfig = {
      assumeRoleArn: 'arn:aws:iam::111111111111:role/acme-build',
      externalId: 'shared-secret-acme',
      region: 'us-west-2',
      sessionDurationSeconds: 1800,
      roleSessionName: 'pb-acme-session',
    };
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver: async () => cfg });

    const provider = await manager.getCredentials('org-acme');
    expect(fromTempCalls).toHaveLength(1);
    const args = fromTempCalls[0] as { params: Record<string, unknown> };
    expect(args.params).toMatchObject({
      RoleArn: cfg.assumeRoleArn,
      ExternalId: cfg.externalId,
      RoleSessionName: cfg.roleSessionName,
      DurationSeconds: cfg.sessionDurationSeconds,
    });

    const creds = await provider();
    expect(creds.accessKeyId).toBe(`AKIA-${cfg.assumeRoleArn}`);
  });

  it('omits ExternalId when the config does not set one', async () => {
    const cfg: OrgAwsConfig = { assumeRoleArn: 'arn:aws:iam::222222222222:role/no-eid' };
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver: async () => cfg });

    await manager.getCredentials('org-noeid');
    const args = fromTempCalls[0] as { params: Record<string, unknown> };
    expect('ExternalId' in args.params).toBe(false);
  });

  it('defaults session name to pipeline-builder-<orgId> when not specified', async () => {
    const cfg: OrgAwsConfig = { assumeRoleArn: 'arn:aws:iam::333333333333:role/default-name' };
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver: async () => cfg });

    await manager.getCredentials('org-dn');
    const args = fromTempCalls[0] as { params: Record<string, unknown> };
    expect(args.params.RoleSessionName).toBe('pipeline-builder-org-dn');
  });

  it('caches the provider per-org so a second call does not re-resolve', async () => {
    const cfg: OrgAwsConfig = { assumeRoleArn: 'arn:aws:iam::444444444444:role/cached' };
    const resolver = jest.fn().mockResolvedValue(cfg);
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver });

    await manager.getCredentials('org-c');
    await manager.getCredentials('org-c');
    await manager.getCredentials('org-c');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(fromTempCalls).toHaveLength(1);
  });

  it('coalesces concurrent first-touch callers for the same org', async () => {
    const cfg: OrgAwsConfig = { assumeRoleArn: 'arn:aws:iam::555555555555:role/coalesce' };
    // Slow resolver — all three callers should await the same in-flight promise.
    const resolver = jest.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r(cfg), 20)));
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver });

    await Promise.all([manager.getCredentials('org-q'), manager.getCredentials('org-q'), manager.getCredentials('org-q')]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(fromTempCalls).toHaveLength(1);
  });

  it('different orgs get independent providers (no cache cross-contamination)', async () => {
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({
      resolver: async (orgId) => ({ assumeRoleArn: `arn:aws:iam::000000000000:role/${orgId}` }),
    });

    const a = await manager.getCredentials('org-a');
    const b = await manager.getCredentials('org-b');
    const credsA = await a();
    const credsB = await b();
    expect(credsA.accessKeyId).toBe('AKIA-arn:aws:iam::000000000000:role/org-a');
    expect(credsB.accessKeyId).toBe('AKIA-arn:aws:iam::000000000000:role/org-b');
    expect(fromTempCalls).toHaveLength(2);
  });

  it('evict() drops the cached provider so the next call re-resolves', async () => {
    const cfg: OrgAwsConfig = { assumeRoleArn: 'arn:aws:iam::666666666666:role/evictable' };
    const resolver = jest.fn().mockResolvedValue(cfg);
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver });

    await manager.getCredentials('org-e');
    expect(resolver).toHaveBeenCalledTimes(1);

    manager.evict('org-e');
    await manager.getCredentials('org-e');
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('evictAll() drops every cached provider', async () => {
    const resolver = jest.fn().mockImplementation(async (orgId: string) => ({ assumeRoleArn: `arn:aws:iam::000:role/${orgId}` }));
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver });

    await manager.getCredentials('org-a');
    await manager.getCredentials('org-b');
    expect(resolver).toHaveBeenCalledTimes(2);

    manager.evictAll();
    await manager.getCredentials('org-a');
    await manager.getCredentials('org-b');
    expect(resolver).toHaveBeenCalledTimes(4);
  });

  it('rejects empty orgId rather than building an unscoped provider', async () => {
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver: async () => null });
    await expect(manager.getCredentials('')).rejects.toThrow(/non-empty orgId/);
  });

  it('honors a caller-supplied fallback over the default chain', async () => {
    const customFallback = jest.fn().mockResolvedValue({ accessKeyId: 'AKIA-CUSTOM', secretAccessKey: 's' });
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver: async () => null, fallback: customFallback });

    const provider = await manager.getCredentials('org-cf');
    const creds = await provider();
    expect(creds.accessKeyId).toBe('AKIA-CUSTOM');
    // The default chain was never built — fromNodeProviderChain mock never fired.
    expect(fallbackCalls.count).toBe(0);
  });

  it('treats a config with empty assumeRoleArn as no-config (falls back)', async () => {
    const { OrgAwsCredentialsManager: M } = await import('../src/utils/org-aws-credentials');
    const manager = new M({
      resolver: async () => ({ assumeRoleArn: '' } as unknown as OrgAwsConfig),
    });

    const provider = await manager.getCredentials('org-empty');
    const creds = await provider();
    expect(creds.accessKeyId).toBe('AKIA-FALLBACK');
    expect(fromTempCalls).toHaveLength(0);
  });
});

describe('resolveOrgCredentialsOnce', () => {
  it('returns resolved credentials from a one-shot manager', async () => {
    const cfg: OrgAwsConfig = { assumeRoleArn: 'arn:aws:iam::777777777777:role/oneshot', externalId: 'one' };
    const { resolveOrgCredentialsOnce: r } = await import('../src/utils/org-aws-credentials');
    const creds = await r('org-once', async () => cfg);
    expect(creds.accessKeyId).toBe(`AKIA-${cfg.assumeRoleArn}`);
  });
});

describe('withOrgAwsCredentials', () => {
  it('passes the per-org credential provider to the factory', async () => {
    const cfg: OrgAwsConfig = { assumeRoleArn: 'arn:aws:iam::888888888888:role/wrapper' };
    const { OrgAwsCredentialsManager: M, withOrgAwsCredentials: w } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver: async () => cfg });

    // Factory receives the AwsCredentialIdentityProvider — exactly what an
    // SDK client's `credentials` option accepts.
    const fakeClient = await w(manager, 'org-w', (credentials) => ({ credentials, name: 'FakeClient' }));
    expect(fakeClient.name).toBe('FakeClient');
    expect(typeof fakeClient.credentials).toBe('function');
    const creds = await fakeClient.credentials();
    expect(creds.accessKeyId).toBe(`AKIA-${cfg.assumeRoleArn}`);
  });

  it('invokes the factory exactly once per call (no caching at this layer)', async () => {
    const cfg: OrgAwsConfig = { assumeRoleArn: 'arn:aws:iam::999999999999:role/once' };
    const { OrgAwsCredentialsManager: M, withOrgAwsCredentials: w } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver: async () => cfg });
    const factory = jest.fn((credentials) => ({ credentials }));

    await w(manager, 'org-f', factory);
    await w(manager, 'org-f', factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('threads the no-config fallback provider through to the factory', async () => {
    const { OrgAwsCredentialsManager: M, withOrgAwsCredentials: w } = await import('../src/utils/org-aws-credentials');
    const manager = new M({ resolver: async () => null });
    const client = await w(manager, 'org-no-cfg', (credentials) => ({ credentials }));
    const creds = await client.credentials();
    // Falls through to the default-chain stub from the top-level beforeEach mock.
    expect(creds.accessKeyId).toBe('AKIA-FALLBACK');
  });
});
