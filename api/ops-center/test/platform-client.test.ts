// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/platform-client.ts — every read of platform-held identity data goes
 * through a typed contract (api-core PLATFORM_INTERNAL) with an ops-center
 * service token. Pins: the path + body each contract sends, the token's org
 * binding (system org for the reads, the TARGET org for the tenant-bound email
 * legs), and the failure contract — the quota/audit/org reads THROW (a guessed
 * answer would be wrong), the email sends resolve false.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

process.env.JWT_SECRET ||= 'platform-client-test-secret';

type Reply = { statusCode: number; headers: Record<string, string>; body: unknown } | null;
const mockGet = jest.fn<(path: string, opts?: unknown) => Promise<Reply>>();
const mockPost = jest.fn<(path: string, body: unknown, opts?: unknown) => Promise<Reply>>();
const authFor = jest.fn<(o: { serviceName: string; orgId: string; role: string }) => string>((o) => `Bearer ${o.serviceName}@${o.orgId}`);

const real = await import('@pipeline-builder/api-core');
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createSafeClient: () => ({ get: mockGet, post: mockPost, put: jest.fn(), delete: jest.fn() }),
  getServiceAuthHeader: (o: { serviceName: string; orgId: string; role: string }) => authFor(o),
}));

const client = await import('../src/services/platform-client.js');
const ORG = '0123456789abcdef01234567';
const ok = (data: unknown): Reply => ({ statusCode: 200, headers: {}, body: { success: true, data } });

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  authFor.mockClear();
});

describe('resolveAccountRoot', () => {
  it('reads the account root with a system-org service token', async () => {
    mockGet.mockResolvedValue(ok({ orgId: ORG, rootOrgId: 'root-1' }));
    await expect(client.resolveAccountRoot(ORG)).resolves.toBe('root-1');
    expect(mockGet.mock.calls[0]![0]).toBe(`/internal/ops/org-account-root/${ORG}`);
    expect(authFor).toHaveBeenCalledWith(expect.objectContaining({ serviceName: 'ops-center', orgId: real.SYSTEM_ORG_ID }));
  });

  it('throws rather than guess when platform cannot answer', async () => {
    mockGet.mockResolvedValue({ statusCode: 404, headers: {}, body: {} });
    await expect(client.resolveAccountRoot(ORG)).rejects.toThrow(/HTTP 404/);
    mockGet.mockResolvedValue(null);
    await expect(client.resolveAccountRoot(ORG)).rejects.toBeInstanceOf(client.PlatformUnavailableError);
  });
});

describe('queryAuditActivity', () => {
  const body = { query: 'recent_events' as const, scope: { isSuperAdmin: false, orgId: ORG }, range: '1h' as const, end: 1, limit: 10, vars: {} };

  it('POSTs the aggregation and returns the parsed result', async () => {
    mockPost.mockResolvedValue(ok({ kind: 'stream', entries: [] }));
    await expect(client.queryAuditActivity(body)).resolves.toEqual({ kind: 'stream', entries: [] });
    expect(mockPost.mock.calls[0]![0]).toBe('/internal/ops/audit-activity');
    expect(mockPost.mock.calls[0]![1]).toEqual(body);
  });

  it('throws when the reply is not a result', async () => {
    mockPost.mockResolvedValue(ok({ kind: 'nope' }));
    await expect(client.queryAuditActivity(body)).rejects.toThrow(/invalid-response/);
  });
});

describe('listLiveOrgIds', () => {
  it('passes the limit and returns the ids', async () => {
    mockGet.mockResolvedValue(ok({ orgIds: ['a', 'b'] }));
    await expect(client.listLiveOrgIds(5)).resolves.toEqual(['a', 'b']);
    expect(mockGet.mock.calls[0]![0]).toBe('/internal/ops/live-org-ids?limit=5');
  });

  it('throws when platform is unreachable', async () => {
    mockGet.mockResolvedValue(null);
    await expect(client.listLiveOrgIds(5)).rejects.toThrow(/unreachable/);
  });
});

describe('email relay legs', () => {
  it('sends an alert email on the alert leg, tenant-bound to the destination org', async () => {
    mockPost.mockResolvedValue(ok({ ok: true, recipientCount: 1 }));
    await expect(client.sendAlertEmail({ orgId: ORG, to: 'ops@acme.test', subject: 's', text: 't' })).resolves.toBe(true);
    expect(mockPost.mock.calls[0]![0]).toBe('/internal/notify-email');
    expect(mockPost.mock.calls[0]![1]).toEqual({ alertEmail: true, orgId: ORG, to: 'ops@acme.test', subject: 's', text: 't' });
    expect(authFor).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG }));
  });

  it('reports a suppressed / refused / unreachable send as not sent', async () => {
    mockPost.mockResolvedValueOnce(ok({ ok: false, suppressed: 1 }));
    await expect(client.sendAlertEmail({ orgId: ORG, to: 'a@b.c', subject: 's', text: 't' })).resolves.toBe(false);
    mockPost.mockResolvedValueOnce({ statusCode: 403, headers: {}, body: {} });
    await expect(client.sendAlertEmail({ orgId: ORG, to: 'a@b.c', subject: 's', text: 't' })).resolves.toBe(false);
    // A body its own contract refuses never leaves the process — and never throws out.
    await expect(client.sendAlertEmail({ orgId: ORG, to: '', subject: 's', text: 't' })).resolves.toBe(false);
  });

  it('notifies the org admins on the tenant leg (platform resolves the recipients)', async () => {
    mockPost.mockResolvedValue(ok({ ok: true, recipientCount: 2 }));
    await expect(client.notifyOrgAdmins({ orgId: ORG, subject: 's', text: 't' })).resolves.toBe(true);
    expect(mockPost.mock.calls[0]![1]).toEqual({ orgId: ORG, subject: 's', text: 't', targetUsers: null });
    await expect(client.notifyOrgAdmins({ orgId: ORG, subject: '', text: 't' })).resolves.toBe(false);
  });

  it('reads the deploy email switch, null when platform cannot say', async () => {
    mockGet.mockResolvedValueOnce(ok({ enabled: false }));
    await expect(client.fetchEmailEnabled()).resolves.toBe(false);
    mockGet.mockResolvedValueOnce(null);
    await expect(client.fetchEmailEnabled()).resolves.toBeNull();
  });
});
