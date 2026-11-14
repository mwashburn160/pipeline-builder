// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * The incident client: the ONE support call that fails CLOSED.
 *
 * Spending an incident is a purchase decision, not a promise, so every failure
 * mode — a non-2xx, a timeout, a transport error, a body that doesn't say
 * `consumed: true` — must read as "not consumed" (no case opened), and none may
 * throw into the send path. Refund is best-effort and must never throw either.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockWarn = jest.fn<AnyFn>();
const mockError = jest.fn<AnyFn>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ warn: mockWarn, info: () => {}, debug: () => {}, error: mockError }),
  getServiceAuthHeader: () => 'Bearer service-token',
  envInt: (_n: string, d: number) => d,
  errorMessage: (e: unknown) => String(e),
  SYSTEM_ORG_ID: '000000000000000000000001',
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { billingHost: 'billing', billingPort: 3000 } }) },
}));

const { consumeSupportIncident, refundSupportIncident } = await import('../src/services/support-incident-client.js');

let fetchMock: jest.Mock<AnyFn>;
function respond(init: { ok: boolean; status?: number; body?: unknown } | Error): void {
  fetchMock = init instanceof Error
    ? jest.fn<AnyFn>(async () => { throw init; })
    : jest.fn<AnyFn>(async () => ({ ok: init.ok, status: init.status ?? 200, json: async () => init.body }));
  (global as { fetch: unknown }).fetch = fetchMock;
}

beforeEach(() => {
  mockWarn.mockReset();
  mockError.mockReset();
});

describe('consumeSupportIncident', () => {
  it('POSTs the consume route with the service token and returns true on consumed:true', async () => {
    respond({ ok: true, body: { data: { consumed: true, remaining: 0 } } });
    await expect(consumeSupportIncident('org-1')).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe('http://billing:3000/billing/internal/support-incidents/org-1/consume');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer service-token');
  });

  it('returns false on consumed:false (none left)', async () => {
    respond({ ok: true, body: { data: { consumed: false, remaining: 0 } } });
    await expect(consumeSupportIncident('org-1')).resolves.toBe(false);
  });

  it('fails CLOSED on a billing 500 — no case, no throw', async () => {
    respond({ ok: false, status: 500, body: {} });
    await expect(consumeSupportIncident('org-1')).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledWith('Incident consume refused by billing', { orgId: 'org-1', status: 500 });
  });

  it('fails CLOSED on a 503 (the account root could not be resolved)', async () => {
    respond({ ok: false, status: 503, body: {} });
    await expect(consumeSupportIncident('team-1')).resolves.toBe(false);
  });

  it('fails CLOSED on a timeout / transport error — no throw', async () => {
    respond(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await expect(consumeSupportIncident('org-1')).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledWith('Incident consume unavailable', expect.objectContaining({ orgId: 'org-1' }));
  });

  it('fails CLOSED on a body that does not literally say consumed:true', async () => {
    respond({ ok: true, body: { data: { consumed: 'yes' } } });
    await expect(consumeSupportIncident('org-1')).resolves.toBe(false);
    respond({ ok: true, body: null });
    await expect(consumeSupportIncident('org-1')).resolves.toBe(false);
  });

  it('url-encodes the org id', async () => {
    respond({ ok: true, body: { data: { consumed: true } } });
    await consumeSupportIncident('a/b');
    expect(fetchMock.mock.calls[0][0]).toBe('http://billing:3000/billing/internal/support-incidents/a%2Fb/consume');
  });
});

describe('refundSupportIncident', () => {
  it('POSTs the refund route', async () => {
    respond({ ok: true, body: { data: { balance: 1 } } });
    await expect(refundSupportIncident('org-1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://billing:3000/billing/internal/support-incidents/org-1/refund');
    expect(mockError).not.toHaveBeenCalled();
  });

  it('logs an ERROR (never throws) when billing refuses the refund', async () => {
    respond({ ok: false, status: 500 });
    await expect(refundSupportIncident('org-1')).resolves.toBeUndefined();
    expect(mockError).toHaveBeenCalledWith('Incident refund refused by billing', { orgId: 'org-1', status: 500 });
  });

  it('logs an ERROR (never throws) when billing is unreachable', async () => {
    respond(new Error('ECONNREFUSED'));
    await expect(refundSupportIncident('org-1')).resolves.toBeUndefined();
    expect(mockError).toHaveBeenCalledWith(
      'Incident refund unavailable — a concession was spent on a failed case',
      expect.objectContaining({ orgId: 'org-1' }),
    );
  });
});
