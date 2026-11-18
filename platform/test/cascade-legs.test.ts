// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cascade legs: WHERE each downstream half of an org purge / user erasure
 * is delivered, and what counts as the ack.
 *
 *  - every service holding org data has an `org.deleted` leg — the Postgres
 *    owners (pipeline, plugin, compliance, message, reporting, ops-center), the
 *    Mongo owners (quota, billing), message blobs and the registry — each
 *    delivered through its typed internal contract;
 *  - the contract legs call exactly the contract's method + path, with the
 *    platform service token and the purged org in `x-org-id`;
 *  - the ack is a 2xx and nothing else; an unreachable service, a non-2xx, or a
 *    throwing client is a failure (retried), never a throw.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockPost = jest.fn<AnyFn>();
const mockDelete = jest.fn<AnyFn>();
const clients: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: (opts: Record<string, unknown>) => {
    clients.push(opts);
    return { post: mockPost, delete: mockDelete, get: jest.fn(), put: jest.fn() };
  },
  getServiceAuthHeader: () => 'Bearer platform-service-token',
}));
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({
  pipeline: { serviceHost: 'pipeline', servicePort: 3000 },
  plugin: { serviceHost: 'plugin', servicePort: 3000 },
  compliance: { serviceHost: 'compliance', servicePort: 3000 },
  message: { serviceHost: 'message', servicePort: 3000 },
  reporting: { serviceHost: 'reporting', servicePort: 3000 },
  opsCenter: { serviceHost: 'ops-center', servicePort: 3000 },
  quota: { serviceHost: 'quota', servicePort: 3000 },
  billing: { serviceHost: 'billing', servicePort: 3000 },
  imageRegistry: { serviceHost: 'image-registry', servicePort: 3000 },
  organization: { cascadeHttpTimeoutMs: 5000, registryCascadeHttpTimeoutMs: 120_000 },
}));

const { CASCADE_LEGS, legsFor, findLeg } = await import('../src/services/cascade-legs.js');

const ORG = 'org-acme';
const ok = (data: unknown) => ({ statusCode: 200, headers: {}, body: { success: true, data } });

beforeEach(() => {
  jest.clearAllMocks();
  clients.length = 0;
  mockPost.mockResolvedValue(ok({ orgId: ORG, tables: { pipelines: 2 } }));
  mockDelete.mockResolvedValue(ok({ orgId: ORG, deleted: 3 }));
});

describe('the leg registry', () => {
  it('fans an org purge out to every service that holds org data', () => {
    expect(legsFor('org.deleted').map((l) => l.service).sort()).toEqual([
      'billing', 'compliance', 'image-registry', 'message', 'message-blobs', 'ops-center', 'pipeline', 'plugin', 'quota', 'reporting',
    ]);
  });

  it('fans a user erasure out to the plugin service (listing reviews)', () => {
    expect(legsFor('user.erased').map((l) => l.service)).toEqual(['plugin']);
  });

  it('names each leg once per kind, and finds it by (kind, service)', () => {
    const keys = CASCADE_LEGS.map((l) => `${l.kind}/${l.service}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(findLeg('org.deleted', 'pipeline')?.service).toBe('pipeline');
    expect(findLeg('user.erased', 'pipeline')).toBeUndefined();
  });
});

describe('contract legs', () => {
  it.each([
    ['pipeline', 'pipeline', '/pipelines/internal/orgs/org-acme/purge'],
    ['plugin', 'plugin', '/internal/plugins/orgs/org-acme/purge'],
    ['compliance', 'compliance', '/compliance/internal/orgs/org-acme/purge'],
    ['message', 'message', '/messages/internal/orgs/org-acme/purge'],
    ['reporting', 'reporting', '/reports/internal/orgs/org-acme/purge'],
    ['ops-center', 'ops-center', '/ops/internal/orgs/org-acme/purge'],
    ['quota', 'quota', '/quotas/internal/orgs/org-acme/purge'],
    ['billing', 'billing', '/billing/internal/orgs/org-acme/purge'],
  ])('%s: POSTs its own purge contract with the platform token', async (service, host, path) => {
    // Billing reads its body for a partial purge, so it gets a reply in its own shape.
    if (service === 'billing') mockPost.mockResolvedValue(ok({ orgId: ORG, tables: { subscriptions: 1, billingEvents: 0 }, remaining: {} }));
    const res = await findLeg('org.deleted', service)!.deliver(ORG);
    expect(res).toEqual({ ok: true, statusCode: 200 });
    expect(clients[0]).toMatchObject({ host, port: 3000, timeout: 5000 });
    expect(mockPost).toHaveBeenCalledWith(path, undefined, {
      headers: { 'Authorization': 'Bearer platform-service-token', 'x-org-id': ORG },
    });
  });

  it('message-blobs and image-registry DELETE their existing contracts; the registry gets its own timeout', async () => {
    await findLeg('org.deleted', 'message-blobs')!.deliver(ORG);
    await findLeg('org.deleted', 'image-registry')!.deliver(ORG);
    const paths = mockDelete.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(['/messages/internal/org/org-acme/attachments', '/internal/org-namespace/org-acme']);
    expect(clients[1]).toMatchObject({ host: 'image-registry', timeout: 120_000 });
  });

  it('a registry 200 that names repositories it could NOT delete is not an ack (the leg retries)', async () => {
    mockDelete.mockResolvedValue(ok({ repositories: 3, deleted: 2, failed: ['org-acme/lint'] }));
    expect(await findLeg('org.deleted', 'image-registry')!.deliver(ORG))
      .toEqual({ ok: false, statusCode: 200, error: 'registry purge incomplete: 1 repositories left' });
    mockDelete.mockResolvedValue(ok({ repositories: 3, deleted: 3, failed: [] }));
    expect(await findLeg('org.deleted', 'image-registry')!.deliver(ORG)).toEqual({ ok: true, statusCode: 200 });
  });

  it('the user-erasure leg names the user and binds the token to the system org', async () => {
    mockPost.mockResolvedValue(ok({ userId: 'u-1', reviews: 2 }));
    const res = await findLeg('user.erased', 'plugin')!.deliver('u-1');
    expect(res.ok).toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/internal/plugins/users/u-1/erase', undefined, {
      headers: { 'Authorization': 'Bearer platform-service-token', 'x-org-id': '000000000000000000000001' },
    });
  });

  it('acks a 2xx whose body does not match the contract (the delete happened)', async () => {
    mockPost.mockResolvedValue({ statusCode: 200, headers: {}, body: { data: { unexpected: true } } });
    expect(await findLeg('org.deleted', 'compliance')!.deliver(ORG)).toEqual({ ok: true, statusCode: 200 });
  });

  it('a non-2xx is a failure with its status', async () => {
    mockPost.mockResolvedValue({ statusCode: 500, headers: {}, body: {} });
    expect(await findLeg('org.deleted', 'reporting')!.deliver(ORG)).toEqual({ ok: false, statusCode: 500, error: 'HTTP 500' });
  });

  it('an unreachable service is a failure, never a throw', async () => {
    mockPost.mockResolvedValue(null);
    expect(await findLeg('org.deleted', 'pipeline')!.deliver(ORG)).toEqual({ ok: false, error: 'unreachable' });
    mockPost.mockRejectedValue(new Error('socket hang up'));
    expect(await findLeg('org.deleted', 'pipeline')!.deliver(ORG)).toEqual({ ok: false, error: 'socket hang up' });
  });
});

describe('the billing leg (provider cancellation can be partial)', () => {
  const billing = () => findLeg('org.deleted', 'billing')!;

  it('acks a complete purge (nothing remaining)', async () => {
    mockPost.mockResolvedValue(ok({ orgId: ORG, tables: { subscriptions: 1, billingEvents: 4 }, remaining: {} }));
    expect(await billing().deliver(ORG)).toEqual({ ok: true, statusCode: 200 });
    mockPost.mockResolvedValue(ok({ orgId: ORG, tables: { subscriptions: 0, billingEvents: 0 }, remaining: { subscriptions: 0 } }));
    expect(await billing().deliver(ORG)).toEqual({ ok: true, statusCode: 200 });
  });

  it('a 200 that KEPT subscriptions (provider cancel failed) is not an ack — the leg retries', async () => {
    mockPost.mockResolvedValue(ok({ orgId: ORG, tables: { subscriptions: 0, billingEvents: 0 }, remaining: { subscriptions: 2 } }));
    expect(await billing().deliver(ORG))
      .toEqual({ ok: false, statusCode: 200, error: 'billing purge incomplete: 2 subscriptions left' });
  });

  it('a 500 (store failure) is a retry', async () => {
    mockPost.mockResolvedValue({ statusCode: 500, headers: {}, body: {} });
    expect(await billing().deliver(ORG)).toEqual({ ok: false, statusCode: 500, error: 'HTTP 500' });
  });

  it('a 2xx it cannot READ is a retry, not an ack — it cannot prove nothing was kept', async () => {
    // Regression: `invalid-response` acked before the `incomplete` check ran, so a
    // contract drift in `remaining` closed the billing leg with subscriptions
    // still live at the provider.
    mockPost.mockResolvedValue({ statusCode: 200, headers: {}, body: { data: { unexpected: true } } });
    expect(await billing().deliver(ORG)).toEqual({ ok: false, statusCode: 200, error: 'unreadable purge response' });
  });
});

describe('the quota leg', () => {
  it('acks either outcome of the single deleteOne (dropped, or already gone)', async () => {
    const quota = findLeg('org.deleted', 'quota')!;
    mockPost.mockResolvedValue(ok({ orgId: ORG, tables: { organizations: 1 } }));
    expect(await quota.deliver(ORG)).toEqual({ ok: true, statusCode: 200 });
    mockPost.mockResolvedValue(ok({ orgId: ORG, tables: { organizations: 0 } }));
    expect(await quota.deliver(ORG)).toEqual({ ok: true, statusCode: 200 });
    mockPost.mockResolvedValue({ statusCode: 503, headers: {}, body: {} });
    expect(await quota.deliver(ORG)).toEqual({ ok: false, statusCode: 503, error: 'HTTP 503' });
  });
});
