// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the CRUD, tombstone and test-send paths of
 * `AlertDestinationService`. The Drizzle transaction is a chainable double:
 * every builder step returns the chain, and awaiting it yields the next
 * queued result, so each method's own logic (row shaping, `?? null`,
 * `!!row`, severity filtering, delivery-result mapping) is what's asserted.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const results: unknown[] = [];
const calls: Array<[string, unknown[]]> = [];
function makeChain(): any {
  const chain: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        const value = results.shift();
        return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        calls.push([String(prop), args]);
        return chain;
      };
    },
  });
  return chain;
}
const mockWithTenantTx = jest.fn(async (fn: (tx: unknown) => unknown) => fn(makeChain()));
const mockRetentionMs = jest.fn(() => 0);
const mockGetChannel = jest.fn<(name: string) => unknown>();

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ observability: { alertDeliveryTimeoutMs: 5000 } }));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  softDeleteRetentionMs: () => mockRetentionMs(),
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
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...conds: unknown[]) => ({ and: conds }),
  asc: (col: unknown) => ({ asc: col }),
  desc: (col: unknown) => ({ desc: col }),
  eq: (col: unknown, v: unknown) => ({ eq: [col, v] }),
  isNull: (col: unknown) => ({ isNull: col }),
  sql: ((strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join('?'), vals })) as unknown,
}));
jest.unstable_mockModule('../src/services/notification-channels.js', () => ({
  ...jest.requireActual<Record<string, unknown>>('../src/services/notification-channels.js'),
  getNotificationChannel: (name: string) => mockGetChannel(name),
}));

const { alertDestinationService, toApiDestination, DestinationNotFoundError } = await import('../src/services/alert-destination-service.js');

const caller = { orgId: 'org-1', userId: 'user-1' };
const dest = (over: Record<string, unknown> = {}): any => ({
  id: 'd1',
  orgId: 'org-1',
  channel: 'slack',
  target: 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX',
  label: 'Ops',
  minSeverity: 'warning',
  enabled: true,
  ...over,
});
const setCalls = () => calls.filter(([m]) => m === 'set').map(([, a]) => a[0] as Record<string, unknown>);

beforeEach(() => {
  results.length = 0;
  calls.length = 0;
  mockWithTenantTx.mockClear();
  mockRetentionMs.mockReset().mockReturnValue(0);
  mockGetChannel.mockReset();
});

describe('toApiDestination', () => {
  it('masks long targets to the last 12 chars', () => {
    const out = toApiDestination(dest());
    expect(out.target).toBe('••••' + 'XXXXXXXXXXXX');
    expect(out.hasTarget).toBe(true);
  });
  it('masks short targets to the last 4 chars', () => {
    expect(toApiDestination(dest({ target: 'a@b.io' })).target).toBe('••••b.io');
  });
  it('returns an empty target and hasTarget=false when unset', () => {
    const out = toApiDestination(dest({ target: '' }));
    expect(out.target).toBe('');
    expect(out.hasTarget).toBe(false);
  });
});

describe('reads', () => {
  it('listForOrg returns the rows', async () => {
    results.push([dest()]);
    await expect(alertDestinationService.listForOrg('org-1')).resolves.toEqual([dest()]);
  });

  it('findForDelivery fires every destination for critical alerts', async () => {
    results.push([dest({ minSeverity: 'warning' }), dest({ id: 'd2', minSeverity: 'critical' })]);
    const rows = await alertDestinationService.findForDelivery('org-1', 'critical');
    expect(rows.map((r) => r.id)).toEqual(['d1', 'd2']);
  });

  it('findForDelivery fires only warning-tier destinations for warnings', async () => {
    results.push([dest({ minSeverity: 'warning' }), dest({ id: 'd2', minSeverity: 'critical' })]);
    const rows = await alertDestinationService.findForDelivery('org-1', 'warning');
    expect(rows.map((r) => r.id)).toEqual(['d1']);
  });

  it('findById returns the first row or null', async () => {
    results.push([dest()]);
    await expect(alertDestinationService.findById('d1', 'org-1')).resolves.toEqual(dest());
    results.push([]);
    await expect(alertDestinationService.findById('nope', 'org-1')).resolves.toBeNull();
  });

  it('listDeletedForOrg returns tombstones', async () => {
    results.push([dest({ deletedAt: new Date() })]);
    await expect(alertDestinationService.listDeletedForOrg('org-1')).resolves.toHaveLength(1);
  });

  it('findDeletedById returns the first tombstone or null', async () => {
    results.push([dest()]);
    await expect(alertDestinationService.findDeletedById('d1', 'org-1')).resolves.toEqual(dest());
    results.push([]);
    await expect(alertDestinationService.findDeletedById('d1', 'org-1')).resolves.toBeNull();
  });
});

describe('writes', () => {
  it('create applies defaults and returns the inserted row', async () => {
    results.push([dest()]);
    const row = await alertDestinationService.create({ channel: 'slack', target: 'x', label: 'Ops' }, caller);
    expect(row.id).toBe('d1');
    const values = calls.find(([m]) => m === 'values')![1][0] as Record<string, unknown>;
    expect(values).toMatchObject({ orgId: 'org-1', createdBy: 'user-1', minSeverity: 'warning', enabled: true });
  });

  it('create keeps explicit severity / enabled', async () => {
    results.push([dest()]);
    await alertDestinationService.create({ channel: 'email', target: 'a@b.io', label: 'L', minSeverity: 'critical', enabled: false }, caller);
    const values = calls.find(([m]) => m === 'values')![1][0] as Record<string, unknown>;
    expect(values).toMatchObject({ minSeverity: 'critical', enabled: false, channel: 'email' });
  });

  it('update patches only provided fields and keeps target on empty string', async () => {
    results.push([dest({ label: 'New' })]);
    const row = await alertDestinationService.update('d1', { label: 'New', target: '', enabled: false }, caller);
    expect(row?.label).toBe('New');
    const patch = setCalls()[0];
    expect(patch).toEqual({ updatedBy: 'user-1', label: 'New', enabled: false });
  });

  it('update sets every field when all are provided', async () => {
    results.push([dest()]);
    await alertDestinationService.update('d1', {
      channel: 'webhook', target: 'https://x', label: 'L', minSeverity: 'critical', enabled: true,
    }, caller);
    expect(setCalls()[0]).toEqual({
      updatedBy: 'user-1', channel: 'webhook', target: 'https://x', label: 'L', minSeverity: 'critical', enabled: true,
    });
  });

  it('update returns null when no row matched', async () => {
    results.push([]);
    await expect(alertDestinationService.update('nope', {}, caller)).resolves.toBeNull();
  });

  it('delete soft-deletes without purgeAfter when retention is 0', async () => {
    results.push([{ id: 'd1' }]);
    await expect(alertDestinationService.delete('d1', caller)).resolves.toBe(true);
    expect(setCalls()[0]).not.toHaveProperty('purgeAfter');
  });

  it('delete stamps purgeAfter when retention is positive, false when nothing matched', async () => {
    mockRetentionMs.mockReturnValue(1000);
    results.push([]);
    await expect(alertDestinationService.delete('d1', caller)).resolves.toBe(false);
    expect(setCalls()[0].purgeAfter).toBeInstanceOf(Date);
  });

  it('purgeById reports whether a tombstone was removed', async () => {
    results.push([{ id: 'd1' }]);
    await expect(alertDestinationService.purgeById('d1', 'org-1')).resolves.toBe(true);
    results.push([]);
    await expect(alertDestinationService.purgeById('d1', 'org-1')).resolves.toBe(false);
  });

  it('restore clears deletedAt and reports the outcome', async () => {
    results.push([{ id: 'd1' }]);
    await expect(alertDestinationService.restore('d1', caller)).resolves.toBe(true);
    expect(setCalls()[0]).toMatchObject({ deletedAt: null, deletedBy: null, purgeAfter: null, updatedBy: 'user-1' });
    results.push([]);
    await expect(alertDestinationService.restore('d1', caller)).resolves.toBe(false);
  });
});

describe('sendTestNotification', () => {
  const actor = { userId: 'user-1', email: 'ops@example.com' };
  const withChannel = (deliver: (...a: unknown[]) => Promise<unknown>) => {
    const fn = jest.fn(deliver);
    mockGetChannel.mockReturnValue({ deliver: fn });
    return fn;
  };

  it('throws DestinationNotFoundError for a missing destination', async () => {
    results.push([]);
    await expect(alertDestinationService.sendTestNotification('org-1', 'nope', actor)).rejects.toBeInstanceOf(DestinationNotFoundError);
  });

  it('reports an unknown channel as a structured failure', async () => {
    results.push([dest({ channel: 'pager' })]);
    mockGetChannel.mockReturnValue(null);
    await expect(alertDestinationService.sendTestNotification('org-1', 'd1', actor))
      .resolves.toEqual({ delivered: false, error: 'Unknown notification channel "pager"' });
  });

  it('delivers a labelled test message through the channel', async () => {
    results.push([dest()]);
    const deliver = withChannel(async () => ({ ok: true }));
    await expect(alertDestinationService.sendTestNotification('org-1', 'd1', actor)).resolves.toEqual({ delivered: true });
    const [msg, target] = deliver.mock.calls[0] as [any, any];
    expect(msg.payload).toMatchObject({ test: true, destinationId: 'd1', sentBy: 'ops@example.com' });
    expect(target).toEqual({ value: dest().target, orgId: 'org-1' });
  });

  it('falls back to the userId when the actor has no email', async () => {
    results.push([dest()]);
    const deliver = withChannel(async () => ({ ok: true }));
    await alertDestinationService.sendTestNotification('org-1', 'd1', { userId: 'u-9' });
    expect((deliver.mock.calls[0] as [any])[0].payload.sentBy).toBe('u-9');
  });

  it('maps skipped deliveries', async () => {
    results.push([dest()], [dest()]);
    withChannel(async () => ({ ok: true, skipped: true, error: 'muted' }));
    await expect(alertDestinationService.sendTestNotification('org-1', 'd1', actor)).resolves.toEqual({ delivered: false, error: 'muted' });
    withChannel(async () => ({ ok: false, skipped: true }));
    await expect(alertDestinationService.sendTestNotification('org-1', 'd1', actor)).resolves.toEqual({ delivered: false, error: 'Delivery skipped' });
  });

  it('maps failed deliveries with error text, HTTP code, or neither', async () => {
    results.push([dest()], [dest()], [dest()]);
    withChannel(async () => ({ ok: false, error: 'boom' }));
    await expect(alertDestinationService.sendTestNotification('org-1', 'd1', actor)).resolves.toEqual({ delivered: false, error: 'boom' });
    withChannel(async () => ({ ok: false, code: 502 }));
    await expect(alertDestinationService.sendTestNotification('org-1', 'd1', actor)).resolves.toEqual({ delivered: false, error: 'Delivery failed (HTTP 502)' });
    withChannel(async () => ({ ok: false }));
    await expect(alertDestinationService.sendTestNotification('org-1', 'd1', actor)).resolves.toEqual({ delivered: false, error: 'Delivery failed' });
  });

  it('maps an AbortError to a timeout message and other throws to their message', async () => {
    results.push([dest()], [dest()]);
    withChannel(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    await expect(alertDestinationService.sendTestNotification('org-1', 'd1', actor))
      .resolves.toEqual({ delivered: false, error: 'Delivery timed out after 5000ms' });
    withChannel(async () => { throw new Error('ECONNREFUSED'); });
    await expect(alertDestinationService.sendTestNotification('org-1', 'd1', actor))
      .resolves.toEqual({ delivered: false, error: 'ECONNREFUSED' });
  });
});
