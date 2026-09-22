// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `recordAudit` — the ONE emitter for the durable central audit trail. The
 * service identity is bound once at boot (`wireServiceSecurity` →
 * `bindAuditService`); these pin the bound / unbound contract:
 *  - unbound → a loud "audit not initialised" error, never a silently
 *    unattributed (or wrongly attributed) event;
 *  - bound → the event is delivered under the bound service's name, through a
 *    lazily-built client on that service's own spool key;
 *  - the test helper binds a spy and unbinding restores the unbound state.
 */

import { jest, describe, it, expect, afterEach } from '@jest/globals';
import type { AnyFn } from '../src/testing/any-fn.js';

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  createLogger: () => ({ info: jest.fn<AnyFn>(), warn: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), debug: jest.fn<AnyFn>() }),
}));
const getServiceAuthHeader = jest.fn((..._args: unknown[]) => 'Bearer service-token');
jest.unstable_mockModule('../src/middleware/service-tokens.js', () => ({ getServiceAuthHeader }));
jest.unstable_mockModule('../src/middleware/permission-gates.js', () => ({ setAuthzDenialAuditor: jest.fn<AnyFn>() }));
const mockPost = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/http-client.js', () => ({
  createSafeClient: () => ({ post: mockPost, get: jest.fn<AnyFn>(), put: jest.fn<AnyFn>(), delete: jest.fn<AnyFn>() }),
}));
const createEnvRedisAuditSpool = jest.fn<AnyFn>(() => null);
jest.unstable_mockModule('../src/services/audit-spool.js', () => ({
  auditSpoolKey: (serviceName: string) => `audit:spool:${serviceName}`,
  createEnvRedisAuditSpool,
}));

const { recordAudit, bindAuditService, getBoundAuditClient, unbindAuditService } = await import('../src/services/remote-audit-client.js');
const { bindTestAuditService, unbindTestAuditService } = await import('../src/testing/audit-binding.js');

const EVENT = {
  action: 'pipeline.create' as const,
  actorId: 'user-1',
  orgId: 'org-acme',
  targetType: 'pipeline',
  targetId: 'pl-1',
};

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

afterEach(() => {
  unbindAuditService();
  jest.clearAllMocks();
});

describe('recordAudit — unbound', () => {
  it('throws a clear "audit not initialised" error before a service is bound', () => {
    expect(() => recordAudit(EVENT)).toThrow(/audit not initialised.*wireServiceSecurity/);
  });

  it('refuses to hand out a client before a service is bound', () => {
    expect(() => getBoundAuditClient()).toThrow(/audit not initialised/);
  });
});

describe('recordAudit — bound', () => {
  it('delivers the event under the bound service name via a lazily-built client', async () => {
    mockPost.mockResolvedValue({ statusCode: 202, body: {}, headers: {} });
    bindAuditService('billing');
    // Lazy: binding alone must not build the client (no spool connection at import).
    expect(createEnvRedisAuditSpool).not.toHaveBeenCalled();

    recordAudit(EVENT);
    await flush();

    expect(createEnvRedisAuditSpool).toHaveBeenCalledWith({ key: 'audit:spool:billing' });
    expect(getServiceAuthHeader).toHaveBeenCalledWith(expect.objectContaining({ serviceName: 'billing', orgId: 'org-acme' }));
    expect(mockPost).toHaveBeenCalledWith('/audit/events', expect.objectContaining(EVENT), expect.anything());
  });

  it('builds the client once and reuses it for every emission', () => {
    bindAuditService('quota');
    expect(getBoundAuditClient()).toBe(getBoundAuditClient());
    expect(createEnvRedisAuditSpool).toHaveBeenCalledTimes(1);
  });

  it('routes through an injected client and closes it on rebind', () => {
    const first = { record: jest.fn<AnyFn>(), close: jest.fn<AnyFn>() };
    bindAuditService('pipeline', first);
    recordAudit(EVENT);
    expect(first.record).toHaveBeenCalledWith(EVENT, 'pipeline');

    bindAuditService('plugin', { record: jest.fn<AnyFn>(), close: jest.fn<AnyFn>() });
    expect(first.close).toHaveBeenCalledTimes(1);
  });
});

describe('bindTestAuditService', () => {
  it('binds a spy that receives exactly the recorded event, and unbinding restores the error', () => {
    const spy = bindTestAuditService('compliance');
    recordAudit(EVENT);
    expect(spy).toHaveBeenCalledWith(EVENT);
    expect(mockPost).not.toHaveBeenCalled();

    unbindTestAuditService();
    expect(() => recordAudit(EVENT)).toThrow(/audit not initialised/);
  });

  it('accepts a caller-supplied spy and defaults the service name', () => {
    const spy = jest.fn<(event: unknown) => void>();
    expect(bindTestAuditService(undefined, spy)).toBe(spy);
    recordAudit(EVENT);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
