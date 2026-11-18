// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `AlertRuleService` CRUD / tombstone / materializer reads and
 * `prepareRuleExpr`. The Drizzle transaction is a chainable double: every
 * builder step returns the chain and awaiting it yields the next queued
 * result, so each method's own result shaping is what's asserted.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
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
const mockRunWithTenantContext = jest.fn(async (_ctx: unknown, fn: () => unknown) => fn());
const mockRetentionMs = jest.fn(() => 0);

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  softDeleteRetentionMs: () => mockRetentionMs(),
  schema: {
    orgAlertRule: {
      id: 'id-col', orgId: 'orgId-col', name: 'name-col', enabled: 'enabled-col', deletedAt: 'deletedAt-col',
    },
  },
  withTenantTx: (fn: (tx: unknown) => unknown) => mockWithTenantTx(fn),
  runWithTenantContext: (ctx: unknown, fn: () => unknown) => mockRunWithTenantContext(ctx, fn),
}));
jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...conds: unknown[]) => ({ and: conds }),
  asc: (col: unknown) => ({ asc: col }),
  desc: (col: unknown) => ({ desc: col }),
  eq: (col: unknown, v: unknown) => ({ eq: [col, v] }),
  isNull: (col: unknown) => ({ isNull: col }),
  sql: ((strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join('?'), vals })) as unknown,
}));

const { alertRuleService, prepareRuleExpr } = await import('../src/services/alert-rule-service.js');
const { PromQLRewriteError } = await import('../src/services/promql-rewriter.js');

const rule = (over: Record<string, unknown> = {}): any => ({
  id: 'r1',
  orgId: 'org-1',
  name: 'HighErrors',
  expr: 'up{org_id="org-1"} == 0',
  forDuration: '5m',
  severity: 'warning',
  summary: 's',
  description: '',
  enabled: true,
  ...over,
});
const setCalls = () => calls.filter(([m]) => m === 'set').map(([, a]) => a[0] as Record<string, unknown>);
const valuesCall = () => calls.find(([m]) => m === 'values')![1][0] as Record<string, unknown>;

beforeEach(() => {
  results.length = 0;
  calls.length = 0;
  mockWithTenantTx.mockClear();
  mockRunWithTenantContext.mockClear();
  mockRetentionMs.mockReset().mockReturnValue(0);
});

describe('prepareRuleExpr', () => {
  it('injects the org_id matcher into a bare selector', () => {
    expect(prepareRuleExpr('up == 0', 'org-1')).toContain('org_id="org-1"');
  });

  it('rethrows malformed expressions as PromQLRewriteError', () => {
    expect(() => prepareRuleExpr('up{job="a"', 'org-1')).toThrow(PromQLRewriteError);
  });
});

describe('reads', () => {
  it('listForOrg returns the page and a numeric total from one tx', async () => {
    results.push([rule()], [{ count: '7' }]);
    await expect(alertRuleService.listForOrg('org-1', { offset: 10, limit: 5 })).resolves.toEqual({ rules: [rule()], total: 7 });
    expect(mockWithTenantTx).toHaveBeenCalledTimes(1);
    expect(calls.find(([m]) => m === 'limit')![1]).toEqual([5]);
    expect(calls.find(([m]) => m === 'offset')![1]).toEqual([10]);
  });

  it('findById returns the first row or null', async () => {
    results.push([rule()]);
    await expect(alertRuleService.findById('org-1', 'r1')).resolves.toEqual(rule());
    results.push([]);
    await expect(alertRuleService.findById('org-1', 'nope')).resolves.toBeNull();
  });

  it('listDeletedForOrg returns tombstones', async () => {
    results.push([rule({ deletedAt: new Date() })]);
    await expect(alertRuleService.listDeletedForOrg('org-1')).resolves.toHaveLength(1);
  });

  it('findDeletedById returns the first tombstone or null', async () => {
    results.push([rule()]);
    await expect(alertRuleService.findDeletedById('org-1', 'r1')).resolves.toEqual(rule());
    results.push([]);
    await expect(alertRuleService.findDeletedById('org-1', 'r1')).resolves.toBeNull();
  });

  it('listAllEnabledForMaterializer runs under a superadmin tenant context', async () => {
    results.push([rule(), rule({ id: 'r2', orgId: 'org-2' })]);
    await expect(alertRuleService.listAllEnabledForMaterializer()).resolves.toHaveLength(2);
    expect(mockRunWithTenantContext).toHaveBeenCalledWith(expect.objectContaining({ isSuperAdmin: true }), expect.any(Function));
  });
});

describe('writes', () => {
  it('create applies defaults', async () => {
    results.push([rule()]);
    const row = await alertRuleService.create('org-1', 'user-1', { name: 'HighErrors', expr: 'up', summary: 's' });
    expect(row.id).toBe('r1');
    expect(valuesCall()).toMatchObject({
      orgId: 'org-1',
      createdBy: 'user-1',
      updatedBy: 'user-1',
      forDuration: '5m',
      severity: 'warning',
      description: '',
      enabled: true,
    });
  });

  it('create keeps explicit optional fields', async () => {
    results.push([rule()]);
    await alertRuleService.create('org-1', 'user-1', {
      name: 'N', expr: 'up', summary: 's', forDuration: '1h', severity: 'critical', description: 'd', enabled: false,
    });
    expect(valuesCall()).toMatchObject({ forDuration: '1h', severity: 'critical', description: 'd', enabled: false });
  });

  it('update patches only the provided fields', async () => {
    results.push([rule({ name: 'Renamed' })]);
    await expect(alertRuleService.update('org-1', 'r1', 'user-2', { name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed' });
    expect(setCalls()[0]).toEqual({ updatedBy: 'user-2', name: 'Renamed' });
  });

  it('update sets every field when all are provided, null when nothing matched', async () => {
    results.push([]);
    const input = { name: 'N', expr: 'e', forDuration: '1m', severity: 'critical' as const, summary: 's', description: 'd', enabled: false };
    await expect(alertRuleService.update('org-1', 'r1', 'user-2', input)).resolves.toBeNull();
    expect(setCalls()[0]).toEqual({ updatedBy: 'user-2', ...input });
  });

  it('delete soft-deletes without purgeAfter when retention is 0', async () => {
    results.push([rule()]);
    await expect(alertRuleService.delete('org-1', 'r1', 'user-1')).resolves.toBe(true);
    expect(setCalls()[0]).toMatchObject({ deletedBy: 'user-1' });
    expect(setCalls()[0]).not.toHaveProperty('purgeAfter');
  });

  it('delete stamps purgeAfter with positive retention and returns false on no match', async () => {
    mockRetentionMs.mockReturnValue(60_000);
    results.push([]);
    await expect(alertRuleService.delete('org-1', 'r1', 'user-1')).resolves.toBe(false);
    expect(setCalls()[0].purgeAfter).toBeInstanceOf(Date);
  });

  it('purgeById reports whether a tombstone was removed', async () => {
    results.push([{ id: 'r1' }]);
    await expect(alertRuleService.purgeById('org-1', 'r1')).resolves.toBe(true);
    results.push([]);
    await expect(alertRuleService.purgeById('org-1', 'r1')).resolves.toBe(false);
  });

  it('restore clears the tombstone and reports the outcome', async () => {
    results.push([rule()]);
    await expect(alertRuleService.restore('org-1', 'r1', 'user-3')).resolves.toBe(true);
    expect(setCalls()[0]).toMatchObject({ deletedAt: null, deletedBy: null, updatedBy: 'user-3' });
    results.push([]);
    await expect(alertRuleService.restore('org-1', 'r1', 'user-3')).resolves.toBe(false);
  });
});
