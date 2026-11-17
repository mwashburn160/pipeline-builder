// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * System-notification age-out. The predicate IS the safety argument: only rows
 * written by `/internal/notify` (system org + system actor + `notifications`
 * channel), only thread ROOTS nobody replied to, only past the window.
 * Conversations and support cases must never match.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  envInt: (_n: string, d: number) => d,
  SYSTEM_ACTOR_ID: 'system',
  SYSTEM_ORG_ID: 'sys-org',
}));

let selected: Array<{ id: string }> = [];
const where: unknown[] = [];
const limits: number[] = [];
const deletedIds: unknown[] = [];

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => {
  const tx = {
    select: () => ({ from: () => ({ where: (w: unknown) => { where.push(w); return { limit: async (n: number) => { limits.push(n); return selected; } }; } }) }),
    delete: () => ({ where: (w: { v: string[] }) => { deletedIds.push(w.v); return { returning: async () => w.v.map((id) => ({ id, orgId: 'sys-org', recipientOrgId: `org-of-${id}` })) }; } }),
  };
  return stubModule('@pipeline-builder/pipeline-data', {
    schema: { message: { id: 'id', orgId: 'org_id', recipientOrgId: 'recipient_org_id', createdBy: 'created_by', channel: 'channel', threadId: 'thread_id', createdAt: 'created_at' } },
    withTenantTx: (fn: (t: typeof tx) => unknown) => fn(tx),
  });
});

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...a: unknown[]) => ({ op: 'and', a }),
  eq: (c: unknown, v: unknown) => ({ op: 'eq', c, v }),
  lt: (c: unknown, v: unknown) => ({ op: 'lt', c, v }),
  isNull: (c: unknown) => ({ op: 'isNull', c }),
  inArray: (c: unknown, v: unknown) => ({ op: 'inArray', c, v }),
  sql: (strings: TemplateStringsArray) => ({ op: 'sql', text: strings.join('?') }),
}));

const mockInvalidate = jest.fn<(rows: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../src/services/message-service.js', () => ({
  messageService: { invalidateRemovedMessages: (rows: unknown[]) => mockInvalidate(rows) },
}));

const { purgeAgedNotifications, NOTIFICATION_RETENTION_DAYS } = await import('../src/services/notification-retention.js');

const NOW = new Date('2026-11-13T00:00:00Z');

beforeEach(() => {
  selected = [];
  where.length = 0;
  limits.length = 0;
  deletedIds.length = 0;
  mockInvalidate.mockReset();
  mockInvalidate.mockResolvedValue(undefined);
});

describe('purgeAgedNotifications', () => {
  it('matches ONLY unreplied system notifications past the window', async () => {
    await purgeAgedNotifications(NOW, 250);
    const w = where[0] as { a: Array<Record<string, unknown>> };
    expect(w.a.slice(0, 5)).toEqual([
      { op: 'eq', c: 'org_id', v: 'sys-org' },
      { op: 'eq', c: 'created_by', v: 'system' },
      { op: 'eq', c: 'channel', v: 'notifications' },
      { op: 'isNull', c: 'thread_id' },
      { op: 'lt', c: 'created_at', v: new Date(NOW.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000) },
    ]);
    // A notification somebody replied to became a conversation: kept.
    expect(String((w.a[5] as { text: string }).text)).toContain('NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread_id =');
    expect(limits).toEqual([250]);
  });

  it('deletes the selected batch by id and returns the count', async () => {
    selected = [{ id: 'm1' }, { id: 'm2' }];
    await expect(purgeAgedNotifications(NOW)).resolves.toBe(2);
    expect(deletedIds).toEqual([['m1', 'm2']]);
  });

  it('invalidates the purged notices\' cached inbox views once the batch is gone', async () => {
    selected = [{ id: 'm1' }, { id: 'm2' }];
    await purgeAgedNotifications(NOW);
    expect(mockInvalidate).toHaveBeenCalledWith([
      { id: 'm1', orgId: 'sys-org', recipientOrgId: 'org-of-m1' },
      { id: 'm2', orgId: 'sys-org', recipientOrgId: 'org-of-m2' },
    ]);
  });

  it('a failed invalidation does not fail the sweep — the rows are already gone', async () => {
    selected = [{ id: 'm1' }];
    mockInvalidate.mockRejectedValueOnce(new Error('redis down'));
    await expect(purgeAgedNotifications(NOW)).resolves.toBe(1);
  });

  it('issues no DELETE when nothing is due', async () => {
    await expect(purgeAgedNotifications(NOW)).resolves.toBe(0);
    expect(deletedIds).toHaveLength(0);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('defaults to a one-year window', () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(365);
  });
});
