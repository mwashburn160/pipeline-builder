// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The database security-report store's SQL, rendered through drizzle's real
 * Postgres dialect: the scorecard's summary read must never select the
 * `findings` jsonb, and a slot delete must be bounded to one org's one slot.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const executed: SQL[] = [];
let resultRows: Array<Record<string, unknown>> = [];
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  withTenantTx: async (fn: (tx: unknown) => unknown) => fn({
    execute: async (q: SQL) => { executed.push(q); return { rows: resultRows }; },
  }),
}));

const { drizzleSecurityReportStore } = await import('../src/services/security-report-store.js');
const render = (q: SQL) => new PgDialect().sqlToQuery(q);

const row = {
  id: 'r1',
  org_id: 'acme',
  pipeline_id: 'p1',
  tool: 'grype',
  format: 'grype-json',
  stage: 'Build',
  execution_id: null,
  critical_count: 2,
  high_count: 1,
  medium_count: 0,
  low_count: 0,
  kev_count: 0,
  critical_fixable: 1,
  high_fixable: 0,
  truncated: false,
  submitted_by: 'user:u-1',
  created_at: new Date('2026-11-01T00:00:00Z'),
};

beforeEach(() => { executed.length = 0; resultRows = [row]; });

describe('drizzleSecurityReportStore', () => {
  it('latestSummaries reads the counts and never the findings jsonb', async () => {
    const out = await drizzleSecurityReportStore.latestSummaries('acme', ['p1', 'p2']);
    const { sql, params } = render(executed[0]!);
    expect(sql).not.toMatch(/findings|\*/);
    expect(sql).toMatch(/critical_count/);
    expect(params).toEqual(['acme', 'p1', 'p2']);
    expect(out).toEqual([expect.objectContaining({ id: 'r1', counts: expect.objectContaining({ critical: 2, criticalFixable: 1 }) })]);
    expect(out[0]).not.toHaveProperty('findings');
  });

  it('latestSummaries of no pipelines issues no query', async () => {
    expect(await drizzleSecurityReportStore.latestSummaries('acme', [])).toEqual([]);
    expect(executed).toHaveLength(0);
  });

  it('remove deletes one org\'s one (pipeline, tool, stage) slot and returns it', async () => {
    const out = await drizzleSecurityReportStore.remove('acme', 'p1', 'grype', 'Build');
    const { sql, params } = render(executed[0]!);
    expect(sql).toMatch(/^\s*DELETE FROM pipeline_security_reports\s+WHERE org_id = \$1 AND pipeline_id = \$2 AND tool = \$3 AND stage = \$4/);
    expect(params).toEqual(['acme', 'p1', 'grype', 'Build']);
    expect(out?.id).toBe('r1');
  });

  it('remove answers null when the slot held nothing', async () => {
    resultRows = [];
    expect(await drizzleSecurityReportStore.remove('acme', 'p1', 'grype', '')).toBeNull();
  });
});
