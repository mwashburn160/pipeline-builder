// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The small boot-time pieces of ops-center: the relay-bearer rotation
 * probe (moved from platform's secret-rotation probes), the memoized Redis
 * accessor, and the RLS tenant scope taken from the VERIFIED token.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const instances: Array<{ id: string; token: string; previousToken?: string }> = [];
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ alertWebhook: { get instances() { return instances; } } }));
const createEnvRedisClient = jest.fn<() => unknown>(() => null);
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ createEnvRedisClient: () => createEnvRedisClient() }));

const { previousSecretStates } = await import('@pipeline-builder/api-core');
const { registerOpsSecretRotationProbes } = await import('../src/observability/secret-rotation.js');
const redis = await import('../src/utils/redis-client.js');
const { tenantScope } = await import('../src/middleware/index.js');
const { getTenantContext } = await import('@pipeline-builder/pipeline-data');

const stateOf = (secret: string) => previousSecretStates().find((s) => s.secret === secret)?.previousSet;

describe('ALERT_WEBHOOK_INSTANCE_TOKEN rotation probe', () => {
  beforeEach(() => {
    instances.length = 0;
    registerOpsSecretRotationProbes();
  });

  it('is not rotating by default', () => {
    instances.push({ id: 'alertmanager', token: 'tok' });
    expect(stateOf('ALERT_WEBHOOK_INSTANCE_TOKEN')).toBe(false);
  });

  it('tracks a relay instance carrying a previousToken', () => {
    instances.push({ id: 'alertmanager', token: 'tok-new', previousToken: 'tok-old' });
    expect(stateOf('ALERT_WEBHOOK_INSTANCE_TOKEN')).toBe(true);
  });
});

describe('getRedisClient', () => {
  beforeEach(() => redis.__resetRedisClientForTests());

  it('memoizes "no Redis configured" as undefined', async () => {
    await expect(redis.getRedisClient()).resolves.toBeUndefined();
    await expect(redis.getRedisClient()).resolves.toBeUndefined();
    expect(createEnvRedisClient).toHaveBeenCalledTimes(1);
  });

  it('returns and memoizes a configured client', async () => {
    const client = { set: jest.fn() };
    createEnvRedisClient.mockReturnValueOnce(client);
    await expect(redis.getRedisClient()).resolves.toBe(client);
    await expect(redis.getRedisClient()).resolves.toBe(client);
  });
});

describe('tenantScope', () => {
  it('scopes the rest of the request to the verified org (normalized) and sysadmin flag', async () => {
    const seen: unknown[] = [];
    const req = { user: { sub: 'u1', organizationId: ' ORG-A ', parentOrganizationId: 'p1' }, headers: {} };
    await new Promise<void>((resolve) => {
      tenantScope(req as never, {} as never, () => { seen.push(getTenantContext()); resolve(); });
    });
    expect(seen[0]).toMatchObject({ orgId: 'org-a', userId: 'u1', isSuperAdmin: false, parentOrgId: 'p1' });
  });

  it('an unauthenticated request gets an empty org', async () => {
    const seen: unknown[] = [];
    await new Promise<void>((resolve) => {
      tenantScope({ headers: {} } as never, {} as never, () => { seen.push(getTenantContext()); resolve(); });
    });
    expect(seen[0]).toMatchObject({ orgId: '', isSuperAdmin: false });
  });
});
