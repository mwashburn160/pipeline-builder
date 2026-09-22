// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin-ecosystem notification enqueue + digest dispatcher:
 * immediate events go straight to the relay (queued for retry when it is
 * down); digest events send in-app now and queue the email; the dispatcher
 * coalesces due rows by digest_key into one email, backs off on failure and
 * gives up after MAX_ATTEMPTS.
 *
 * The queue is an in-memory table behind a fake drizzle transaction.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';

interface QRow {
  id: string;
  event: string;
  digestKey: string | null;
  recipientOrgId: string | null;
  recipientUserId: string | null;
  payload: Record<string, unknown>;
  deliverAfter: Date;
  deliveredAt: Date | null;
  createdAt: Date;
}
let table: QRow[] = [];
let seq = 0;

type Cond = { op: string; col?: string; value?: unknown; parts?: Cond[] };
const col = (name: string) => ({ name });
jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...parts: Cond[]) => ({ op: 'and', parts }),
  isNull: (c: { name: string }) => ({ op: 'isNull', col: c.name }),
  lte: (c: { name: string }, value: unknown) => ({ op: 'lte', col: c.name, value }),
  inArray: (c: { name: string }, value: unknown[]) => ({ op: 'in', col: c.name, value }),
  asc: (c: { name: string }) => c.name,
}));
function matchRow(row: QRow, c: Cond): boolean {
  const v = (row as unknown as Record<string, unknown>)[c.col ?? ''];
  switch (c.op) {
    case 'and': return c.parts!.every((p) => matchRow(row, p));
    case 'isNull': return v === null;
    case 'lte': return (v as Date).getTime() <= (c.value as Date).getTime();
    case 'in': return (c.value as unknown[]).includes(v);
    default: return false;
  }
}
const tx = {
  insert: () => ({
    values: async (v: Partial<QRow>) => {
      table.push({ id: `q${++seq}`, deliveredAt: null, createdAt: new Date(), digestKey: null, recipientOrgId: null, recipientUserId: null, payload: {}, ...v } as QRow);
    },
  }),
  select: () => ({
    from: () => ({
      where: (c: Cond) => ({
        orderBy: () => ({
          limit: async (n: number) => table.filter((r) => matchRow(r, c)).sort((a, b) => a.deliverAfter.getTime() - b.deliverAfter.getTime()).slice(0, n).map((r) => ({ ...r })),
        }),
      }),
    }),
  }),
  update: () => ({
    set: (patch: Partial<QRow>) => ({
      where: async (c: Cond) => { for (const r of table) if (matchRow(r, c)) Object.assign(r, patch); },
    }),
  }),
};
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withTenantTx: (fn: (t: typeof tx) => unknown) => fn(tx),
  schema: {
    ecosystemNotificationQueue: {
      id: col('id'), deliveredAt: col('deliveredAt'), deliverAfter: col('deliverAfter'), digestKey: col('digestKey'),
    },
  },
}));
const mockInc = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockInc }));

const mod = await import('../src/services/ecosystem-notifications.js');
const {
  enqueueEcosystemNotification, dispatchDueEcosystemNotifications, setEcosystemNotifyClientForTests,
  createEcosystemNotificationScheduler, backoffMs, MAX_ATTEMPTS,
} = mod;

const mockSend = jest.fn<(...a: unknown[]) => Promise<{ ok: boolean }>>();
const mods = [{ kind: 'moderators' as const, permission: 'plugins:moderate' as const }];

beforeEach(() => {
  table = [];
  seq = 0;
  mockSend.mockReset().mockResolvedValue({ ok: true });
  mockInc.mockReset();
  setEcosystemNotifyClientForTests({ send: mockSend as never });
});

describe('enqueueEcosystemNotification', () => {
  it('sends an immediate event straight away', async () => {
    await expect(enqueueEcosystemNotification('N8', mods, { subject: 'Suspended', text: 't' })).resolves.toBe('sent');
    expect(mockSend).toHaveBeenCalledWith({ event: 'N8', recipients: mods, subject: 'Suspended', text: 't' });
    expect(table).toHaveLength(0);
  });

  it('strips CR/LF and control characters from the subject (user text never injects a header) —', async () => {
    await enqueueEcosystemNotification('N8', mods, { subject: 'Yanked: evil\r\nBcc: x@y\u0007 1.0', text: 'line1\nline2' });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Yanked: evil Bcc: x@y  1.0', text: 'line1\nline2' }));
  });

  it('queues an immediate event for retry when the relay is down (never lost)', async () => {
    mockSend.mockResolvedValue({ ok: false });
    await expect(enqueueEcosystemNotification('N25', [{ kind: 'user', userId: 'u1', orgId: 'o1' }], { subject: 's', text: 't' })).resolves.toBe('retry_queued');
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({ event: 'N25', digestKey: null, recipientOrgId: 'o1', recipientUserId: 'u1' });
    expect(table[0]!.payload).toMatchObject({ channels: ['in_app', 'email'], attempts: 1 });
  });

  it('digest event: in-app now, email queued for the next 09:00 UTC under a per-recipients digest key', async () => {
    await expect(enqueueEcosystemNotification('N24', mods, { subject: 'New listing', text: 't' })).resolves.toBe('queued');
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ event: 'N24', channels: ['in_app'] }));
    expect(table).toHaveLength(1);
    expect(table[0]!.digestKey).toMatch(/^N24:/);
    expect(table[0]!.deliverAfter.getUTCHours()).toBe(9);
    expect(table[0]!.payload).toMatchObject({ channels: ['email'] });
  });

  it('queues the in-app copy too when the immediate in-app send fails', async () => {
    mockSend.mockResolvedValue({ ok: false });
    await enqueueEcosystemNotification('N24', mods, { subject: 's', text: 't' });
    expect(table[0]!.payload).toMatchObject({ channels: ['in_app', 'email'] });
  });

  it('honours an explicit digest key, delay or delivery time', async () => {
    const at = new Date('2030-01-01T00:00:00Z');
    await enqueueEcosystemNotification('N15', [{ kind: 'org_permission', orgId: 'pub', permission: 'publishers:manage' }], { subject: 's', text: 't' }, { digestKey: 'N15:listing-1', deliverAfter: at });
    expect(table[0]).toMatchObject({ digestKey: 'N15:listing-1', deliverAfter: at, recipientOrgId: 'pub' });
    const before = Date.now();
    await enqueueEcosystemNotification('N11', [{ kind: 'user', userId: 'u1' }], { subject: 's', text: 't' }, { delayMs: 60_000 });
    expect(table[1]!.deliverAfter.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('an in-app-only digest event has nothing to queue', async () => {
    await expect(enqueueEcosystemNotification('N26', [{ kind: 'user', userId: 'u1' }], { subject: 's', text: 't' }, { delayMs: 1 })).resolves.toBe('sent');
    expect(table).toHaveLength(0);
  });

  it('immediate + mandatory for a security lane of a digest event (N24 yank)', async () => {
    await expect(enqueueEcosystemNotification('N24', mods, { subject: 'Yank', text: 't' }, { immediate: true, mandatory: true })).resolves.toBe('sent');
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ mandatory: true }));
    expect(mockSend.mock.calls[0]![0]).not.toHaveProperty('channels');
  });

  it('throws on an invalid notice (programming error)', async () => {
    await expect(enqueueEcosystemNotification('N8', [], { subject: 's', text: 't' })).rejects.toThrow(/Invalid ecosystem notification/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('dispatchDueEcosystemNotifications', () => {
  const past = new Date(Date.now() - 1000);
  const row = (over: Partial<QRow>): QRow => ({
    id: `q${++seq}`,
    event: 'N24',
    digestKey: 'N24:mods',
    recipientOrgId: null,
    recipientUserId: null,
    deliveredAt: null,
    createdAt: new Date(),
    deliverAfter: past,
    payload: { recipients: mods, subject: `item ${seq}`, text: 'x', channels: ['email'] },
    ...over,
  });

  it('coalesces due rows sharing a digest key into ONE email, and marks them delivered', async () => {
    table.push(row({}), row({}), row({ digestKey: 'N24:other' }), row({ deliverAfter: new Date(Date.now() + 3_600_000) }));
    const result = await dispatchDueEcosystemNotifications();
    expect(result).toEqual({ groups: 2, delivered: 3, retried: 0, dropped: 0 });
    expect(mockSend).toHaveBeenCalledTimes(2);
    const digest = mockSend.mock.calls[0]![0] as { subject: string; text: string; channels: string[]; recipients: unknown[] };
    expect(digest.subject).toBe('Daily digest: 2 × Publish request submitted');
    expect(digest.text).toBe('• item 1\n• item 2');
    expect(digest.channels).toEqual(['email']);
    expect(digest.recipients).toEqual(mods); // deduplicated
    expect(table.filter((r) => r.deliveredAt).length).toBe(3);
    expect(table[3]!.deliveredAt).toBeNull(); // not yet due
  });

  it('delivers undigested rows one by one and carries the mandatory flag', async () => {
    table.push(row({ digestKey: null, event: 'N8', payload: { recipients: mods, subject: 'a', text: 'b', channels: ['in_app', 'email'], mandatory: true } }));
    await dispatchDueEcosystemNotifications();
    expect(mockSend).toHaveBeenCalledWith({ event: 'N8', recipients: mods, subject: 'a', text: 'b', channels: ['in_app', 'email'], mandatory: true });
  });

  it('backs off on failure, then gives up after MAX_ATTEMPTS', async () => {
    mockSend.mockResolvedValue({ ok: false });
    const now = new Date();
    table.push(row({ deliverAfter: new Date(now.getTime() - 1) }));
    expect(await dispatchDueEcosystemNotifications(now)).toMatchObject({ retried: 1 });
    expect(table[0]!.payload.attempts).toBe(1);
    expect(table[0]!.deliverAfter.getTime()).toBe(now.getTime() + backoffMs(1));

    table[0]!.payload.attempts = MAX_ATTEMPTS - 1;
    table[0]!.deliverAfter = new Date(now.getTime() - 1);
    expect(await dispatchDueEcosystemNotifications(now)).toMatchObject({ dropped: 1 });
    expect(table[0]!.deliveredAt).toEqual(now);
    expect(mockInc).toHaveBeenCalledWith('ecosystem_notification_dropped_total', { event: 'N24' });
  });

  it('drops a corrupt row immediately (it can never be sent)', async () => {
    mockSend.mockRejectedValue(new Error('Invalid ecosystem notification: recipients must be a non-empty array'));
    table.push(row({ payload: { subject: 's', text: 't' } }));
    expect(await dispatchDueEcosystemNotifications()).toMatchObject({ dropped: 1 });
    expect(table[0]!.deliveredAt).not.toBeNull();
  });

  it('does nothing when nothing is due', async () => {
    expect(await dispatchDueEcosystemNotifications()).toEqual({ groups: 0, delivered: 0, retried: 0, dropped: 0 });
  });
});

describe('scheduler + helpers', () => {
  it('backoff doubles per attempt and caps at an hour', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(20)).toBe(3_600_000);
    expect(backoffMs(0)).toBe(60_000);
  });

  it('builds a start/stop scheduler without starting it', () => {
    const s = createEcosystemNotificationScheduler(() => ({ set: jest.fn(), get: jest.fn(), del: jest.fn() }) as never);
    expect(typeof s.start).toBe('function');
    s.stop();
  });

  it('lazily builds the real relay client when none is injected', async () => {
    setEcosystemNotifyClientForTests(undefined);
    // Unreachable platform in tests → the real client reports ok:false → retry queued.
    await expect(enqueueEcosystemNotification('N8', mods, { subject: 's', text: 't' })).resolves.toBe('retry_queued');
  }, 30_000);
});
