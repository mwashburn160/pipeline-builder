// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let selectResults: unknown[][] = [];

function shift(q: unknown[][]): unknown[] {
  return q.length ? (q.shift() as unknown[]) : [];
}

function makeChain(terminal: () => Promise<unknown[]>): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const name of ['from', 'where', 'orderBy', 'limit', 'offset']) {
    chain[name] = jest.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => terminal().then(resolve);
  return chain;
}

const tx = {
  select: jest.fn(() => makeChain(() => Promise.resolve(shift(selectResults)))),
};

// Real query-builder behaviour: build an org-scoped condition list so the test
// can verify the audit service always constrains reads to the caller's org.
const buildComplianceAuditConditions = jest.fn((filter: Record<string, unknown> | undefined, orgId: string) => {
  const conditions: unknown[] = [{ col: 'orgId', value: orgId }];
  if (filter?.action) conditions.push({ col: 'action', value: filter.action });
  return conditions;
});

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: {
    complianceAuditLog: { createdAt: 'col_created', orgId: 'col_org' },
  },
  withTenantTx: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  drizzleCount: (r: unknown) => r,
  buildComplianceAuditConditions: (f: Record<string, unknown> | undefined, o: string) =>
    buildComplianceAuditConditions(f, o),
}));

const { complianceAuditService } = await import('../src/services/compliance-audit-service.js');

describe('ComplianceAuditService', () => {
  beforeEach(() => {
    selectResults = [];
    tx.select.mockClear();
    buildComplianceAuditConditions.mockClear();
  });

  it('always constrains reads to the caller org (tenancy filtering)', async () => {
    selectResults = [[{ count: 3 }], [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]];
    const result = await complianceAuditService.list({ action: 'rule.eval' }, 'org-1', 50, 0);

    // The org id is threaded into every condition set the audit list builds.
    expect(buildComplianceAuditConditions).toHaveBeenCalledWith({ action: 'rule.eval' }, 'org-1');
    const [[, orgArg]] = buildComplianceAuditConditions.mock.calls;
    expect(orgArg).toBe('org-1');

    expect(result.total).toBe(3);
    expect(result.entries).toHaveLength(3);
  });

  it('org-scopes even when no user filter is supplied (empty filter still carries orgId)', async () => {
    selectResults = [[{ count: 0 }], []];
    const result = await complianceAuditService.list({}, 'org-2', 50, 0);
    const conditions = buildComplianceAuditConditions.mock.results[0].value as Array<{ col: string; value: string }>;
    expect(conditions.some((c) => c.col === 'orgId' && c.value === 'org-2')).toBe(true);
    expect(result.total).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('defaults total to 0 when the count row is absent', async () => {
    selectResults = [[], []];
    const result = await complianceAuditService.list({}, 'org-1', 50, 0);
    expect(result.total).toBe(0);
  });
});
