// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading an org's notification destinations.
 *
 * Small surface, two things worth pinning: the predicate (a DISABLED or deleted
 * destination must never be delivered to — an admin who switched one off expects that to
 * hold for every sender, not just the alert relay), and the fact that this read
 * establishes no tenant scope of its own, so RLS is the tenancy gate.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fakeTx, type FakeTx } from './helpers/fake-tx.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

let tx: FakeTx;
let scopes: unknown[];

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({ db: {} }));

jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (t: unknown) => unknown) => fn(tx.tx),
  runWithTenantContext: <T>(ctx: unknown, fn: () => T) => {
    scopes.push(ctx);
    return fn();
  },
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { listEnabledAlertDestinations } = await import('../src/api/alert-destinations.js');

beforeEach(() => {
  tx = fakeTx();
  scopes = [];
});

describe('listEnabledAlertDestinations', () => {
  it('returns the org\'s enabled destinations', async () => {
    tx.queue([
      { id: 'd1', channel: 'slack', target: 'https://hooks.slack.com/services/x', label: 'Eng' },
      { id: 'd2', channel: 'webhook', target: 'https://example.test/hook', label: 'Teams' },
    ]);
    const rows = await listEnabledAlertDestinations('acme');
    expect(rows.map((r) => r.channel)).toEqual(['slack', 'webhook']);
    expect(rows[1]?.label).toBe('Teams');
  });

  it('filters on org, enabled and not deleted', async () => {
    tx.queue([]);
    await listEnabledAlertDestinations('acme');
    const where = tx.of('select')[0]?.whereSql() ?? '';
    expect(where).toContain('org_id');
    // An admin who switched a destination off expects that to hold for EVERY sender, not
    // only the alert relay that happened to be written first.
    expect(where).toContain('enabled');
    expect(where).toContain('deleted_at');
  });

  it('establishes no tenant scope of its own — RLS is the gate', async () => {
    tx.queue([]);
    await listEnabledAlertDestinations('acme');
    expect(scopes).toEqual([]);
  });

  it('returns an empty list rather than failing when nothing is configured', async () => {
    tx.queue([]);
    await expect(listEnabledAlertDestinations('acme')).resolves.toEqual([]);
  });
});
