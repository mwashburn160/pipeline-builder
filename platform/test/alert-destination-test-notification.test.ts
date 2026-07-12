// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `alertDestinationService.sendTestNotification` — the manual
 * "send test notification" path behind POST /alert-destinations/:id/test.
 *
 * The contract:
 *  - looks the destination up ORG-SCOPED (findById(id, orgId)); a missing /
 *    wrong-org row throws DestinationNotFoundError (→ 404 in the controller);
 *  - resolves the channel via getNotificationChannel and delivers through the
 *    SAME guarded channel-send path the real relay uses, with a test payload;
 *  - a transport failure comes back as a STRUCTURED `{ delivered:false, error }`
 *    result, never a throw.
 *
 * `getNotificationChannel` and the destination model (via withTenantTx) are
 * mocked, mirroring the sibling alert-destination-service suite.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import type { DeliveryResult, NotificationMessage } from '../src/services/notification-channels.js';

// findById(id, orgId) → select().from().where().limit(1) → resolves rows[]
const mockLimit = jest.fn<() => Promise<unknown[]>>(async () => []);
const mockWhere = jest.fn(() => ({ limit: mockLimit }));
const mockFrom = jest.fn(() => ({ where: mockWhere }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));
const mockWithTenantTx = jest.fn(async (fn: (tx: unknown) => unknown) => fn({ select: mockSelect }));

const mockDeliver = jest.fn<(msg: NotificationMessage, target: unknown, signal: AbortSignal) => Promise<DeliveryResult>>();
const mockGetChannel = jest.fn<(channel: string) => { channel: string; deliver: typeof mockDeliver } | null>(
  () => ({ channel: 'slack', deliver: mockDeliver }),
);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: {
    orgAlertDestination: {
      orgId: 'orgId-col',
      label: 'label-col',
      deletedAt: 'deletedAt-col',
      enabled: 'enabled-col',
      id: 'id-col',
      minSeverity: 'minSev-col',
    },
  },
  withTenantTx: (fn: (tx: unknown) => unknown) => mockWithTenantTx(fn),
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  asc: (col: unknown) => ({ asc: col }),
  eq: (col: unknown, v: unknown) => ({ eq: [col, v] }),
  isNull: (col: unknown) => ({ isNull: col }),
  sql: (() => undefined) as unknown,
}));

jest.unstable_mockModule('../src/services/notification-channels.js', () => ({
  getNotificationChannel: (c: string) => mockGetChannel(c),
}));

const { alertDestinationService, DestinationNotFoundError } =
  await import('../src/services/alert-destination-service.js');

const destRow = {
  id: 'd1',
  orgId: 'org-a',
  channel: 'slack',
  target: 'https://hooks.slack.com/services/T00/B00/SECRET',
  label: 'oncall',
  minSeverity: 'warning',
  enabled: true,
};

beforeEach(() => {
  mockLimit.mockReset().mockResolvedValue([destRow]);
  mockWhere.mockClear();
  mockFrom.mockClear();
  mockSelect.mockClear();
  mockWithTenantTx.mockClear();
  mockDeliver.mockReset().mockResolvedValue({ ok: true });
  mockGetChannel.mockReset().mockReturnValue({ channel: 'slack', deliver: mockDeliver });
});

describe('alertDestinationService.sendTestNotification', () => {
  it('delivers a labeled TEST payload through the resolved channel (happy path)', async () => {
    const result = await alertDestinationService.sendTestNotification('org-a', 'd1', {
      userId: 'u1',
      email: 'ops@example.com',
    });

    expect(result).toEqual({ delivered: true });
    // Channel resolved from the destination's own channel value.
    expect(mockGetChannel).toHaveBeenCalledWith('slack');
    expect(mockDeliver).toHaveBeenCalledTimes(1);

    const [msg, target, signal] = mockDeliver.mock.calls[0];
    // Clearly a TEST message, attributed to the caller.
    expect(msg.title).toBe('Pipeline Builder — test alert');
    expect(msg.summary).toContain('ops@example.com');
    expect(msg.severity).toBe('info');
    expect((msg.raw as { test?: boolean }).test).toBe(true);
    // Reuses the STORED target (already validated at write time) — not bypassed.
    expect(target).toEqual({ value: destRow.target, orgId: 'org-a' });
    // A bounded-timeout AbortSignal is passed, same as the relay path.
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to userId for attribution when no email is present', async () => {
    await alertDestinationService.sendTestNotification('org-a', 'd1', { userId: 'u1' });
    const [msg] = mockDeliver.mock.calls[0];
    expect(msg.summary).toContain('u1');
  });

  it('throws DestinationNotFoundError for a missing / wrong-org destination', async () => {
    mockLimit.mockResolvedValueOnce([]); // findById resolves no row
    await expect(
      alertDestinationService.sendTestNotification('org-a', 'nope', { userId: 'u1' }),
    ).rejects.toBeInstanceOf(DestinationNotFoundError);
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('surfaces a non-ok channel result as a structured failure (not a throw)', async () => {
    mockDeliver.mockResolvedValueOnce({ ok: false, code: 404 });
    const result = await alertDestinationService.sendTestNotification('org-a', 'd1', { userId: 'u1' });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('404');
  });

  it('surfaces a channel throw as a structured failure (not a throw)', async () => {
    mockDeliver.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await alertDestinationService.sendTestNotification('org-a', 'd1', { userId: 'u1' });
    expect(result).toEqual({ delivered: false, error: 'ECONNREFUSED' });
  });

  it('reports an unknown channel as a structured failure without delivering', async () => {
    mockGetChannel.mockReturnValueOnce(null);
    const result = await alertDestinationService.sendTestNotification('org-a', 'd1', { userId: 'u1' });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain('Unknown notification channel');
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('reports a skipped delivery (e.g. email disabled) as a failure with the reason', async () => {
    mockDeliver.mockResolvedValueOnce({ ok: false, skipped: true, error: 'email-disabled' });
    const result = await alertDestinationService.sendTestNotification('org-a', 'd1', { userId: 'u1' });
    expect(result).toEqual({ delivered: false, error: 'email-disabled' });
  });
});
