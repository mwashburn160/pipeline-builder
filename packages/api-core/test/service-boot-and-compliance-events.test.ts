// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Two boot-time wiring seams that every stateless service depends on and
 * neither of which had a test:
 *
 *  - `wireServiceSecurity` — if either half silently stops being wired, the
 *    fleet loses `authz.denied` auditing or token revocation with no symptom
 *    until someone goes looking.
 *  - `registerComplianceEventSubscriber` — a fire-and-forget notifier, so its
 *    failure mode is invisible BY DESIGN. What must hold is that it swallows
 *    (never breaks the originating mutation), emits a drop metric so sustained
 *    loss is alertable, authenticates as a service principal, and sends a
 *    stable Idempotency-Key so a retry can't double-apply.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const post = jest.fn<(path: string, body: unknown, opts?: { headers?: Record<string, string> }) => Promise<unknown>>();
const emitCounter = jest.fn();
const wireAuthzDenialAuditor = jest.fn();
const setTokenRevocationStore = jest.fn();
const createEnvRedisTokenRevocationStore = jest.fn(() => ({ store: 'redis' }));
const getServiceAuthHeader = jest.fn(() => 'Bearer service-token');

jest.unstable_mockModule('../src/services/http-client.js', () => ({
  InternalHttpClient: jest.fn(() => ({ post })),
}));
jest.unstable_mockModule('../src/utils/metric-emitter.js', () => ({ emitCounter }));
jest.unstable_mockModule('../src/services/remote-audit-client.js', () => ({ wireAuthzDenialAuditor }));
jest.unstable_mockModule('../src/services/token-revocation.js', () => ({ createEnvRedisTokenRevocationStore }));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({ setTokenRevocationStore, getServiceAuthHeader }));

const { wireServiceSecurity } = await import('../src/services/service-boot.js');
const { registerComplianceEventSubscriber } = await import('../src/services/compliance-event-subscriber.js');
const { entityEvents } = await import('../src/services/entity-events.js');

beforeEach(() => {
  jest.clearAllMocks();
  post.mockResolvedValue(undefined);
  // Subscribers accumulate on a module-level singleton; start each test clean.
  (entityEvents as unknown as { subscribers: unknown[] }).subscribers = [];
});

describe('wireServiceSecurity', () => {
  it('wires the authz-denial auditor with the service name', () => {
    const getAuditClient = jest.fn();
    wireServiceSecurity('pipeline', getAuditClient as never);
    expect(wireAuthzDenialAuditor).toHaveBeenCalledWith('pipeline', getAuditClient);
  });

  it('registers the env-Redis token revocation store', () => {
    wireServiceSecurity('plugin', jest.fn() as never);
    expect(createEnvRedisTokenRevocationStore).toHaveBeenCalledTimes(1);
    expect(setTokenRevocationStore).toHaveBeenCalledWith({ store: 'redis' });
  });
});

describe('registerComplianceEventSubscriber', () => {
  const event = {
    target: 'pipeline',
    entityId: 'p-1',
    eventType: 'created',
    orgId: 'org-1',
    timestamp: new Date('2026-09-12T10:00:00.000Z'),
  };

  /**
   * Register, then drive one event through the registered subscriber.
   *
   * `entityEvents.emit()` is deliberately sync fire-and-forget (it never
   * awaits subscribers), so calling the subscriber's `onEntityEvent` directly
   * is what lets us assert its swallow/metric behaviour.
   */
  async function emit(serviceName = 'pipeline') {
    registerComplianceEventSubscriber({ host: 'compliance', port: 3000 }, serviceName);
    const subs = (entityEvents as unknown as { subscribers: Array<{ onEntityEvent: (e: unknown) => Promise<void> }> }).subscribers;
    expect(subs).toHaveLength(1);
    await subs[0].onEntityEvent(event);
  }

  it('forwards the event to the compliance entity-events route', async () => {
    await emit();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('/compliance/events/entity');
    expect(post.mock.calls[0][1]).toEqual(event);
  });

  it('authenticates as a SERVICE principal scoped to the event org', async () => {
    // A spoofable `x-internal-service` header is not accepted by the
    // compliance route; the org scoping drives its tenant GUC.
    await emit('plugin');
    expect(getServiceAuthHeader).toHaveBeenCalledWith({ serviceName: 'plugin', orgId: 'org-1', role: 'member' });
    expect(post.mock.calls[0][2]?.headers?.Authorization).toBe('Bearer service-token');
  });

  it('sends a STABLE Idempotency-Key so a retried delivery cannot double-apply', async () => {
    await emit();
    const first = post.mock.calls[0][2]?.headers?.['Idempotency-Key'];
    expect(first).toBe('pipeline:p-1:created:2026-09-12T10:00:00.000Z');

    // Same event again → byte-identical key.
    post.mockClear();
    const subs = (entityEvents as unknown as { subscribers: Array<{ onEntityEvent: (e: unknown) => Promise<void> }> }).subscribers;
    await subs[0].onEntityEvent(event);
    expect(post.mock.calls[0][2]?.headers?.['Idempotency-Key']).toBe(first);
  });

  it('SWALLOWS a delivery failure — compliance notify must never fail the mutation', async () => {
    post.mockRejectedValue(new Error('compliance unreachable'));
    // The assertion is that this does not reject.
    await expect(emit()).resolves.toBeUndefined();
  });

  it('emits a drop counter on failure so sustained loss is alertable', async () => {
    post.mockRejectedValue(new Error('compliance unreachable'));
    await emit('billing');
    expect(emitCounter).toHaveBeenCalledWith('compliance_event_drop_total', {
      service: 'billing',
      target: 'pipeline',
    });
  });

  it('emits no drop counter on success', async () => {
    await emit();
    expect(emitCounter).not.toHaveBeenCalled();
  });

  it('defaults the host/port from env when no config is passed', async () => {
    const { InternalHttpClient } = await import('../src/services/http-client.js');
    process.env.COMPLIANCE_SERVICE_HOST = 'compliance-svc';
    process.env.COMPLIANCE_SERVICE_PORT = '4000';
    try {
      registerComplianceEventSubscriber();
      expect(InternalHttpClient).toHaveBeenCalledWith({ host: 'compliance-svc', port: 4000 });
    } finally {
      delete process.env.COMPLIANCE_SERVICE_HOST;
      delete process.env.COMPLIANCE_SERVICE_PORT;
    }
  });
});
