// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Scans must evaluate rules against the entity's real attributes — the same
 * `toComplianceAttributes` projection the live entity-event path uses — not a
 * bare `{ id, name }` pair (which made every field-based rule evaluate against
 * nothing). Also covers stale `running` scan recovery.
 *
 * Real: pipeline-data schema + drizzle query construction (connection-less, see
 * recording-db), the rule engine, and api-core's `toComplianceAttributes`.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { createRecordingDb } from './helpers/recording-db.js';

const rdb = createRecordingDb();
const logComplianceCheckMock = jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => undefined);
const findActiveMock = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();

const { toComplianceAttributes } = await import('@pipeline-builder/api-core/lib/utils/compliance-attributes.js');
const { schema } = await import('@pipeline-builder/pipeline-data/lib/database/drizzle-schema.js');

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ toComplianceAttributes }));
jest.unstable_mockModule('@pipeline-builder/api-server', () => ({ incCounter: () => undefined }));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema,
  withTenantTx: async (fn: (tx: unknown) => unknown) => fn(rdb.tx),
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
jest.unstable_mockModule('../src/services/compliance-rule-service.js', () => ({
  complianceRuleService: { findActiveByOrgAndTarget: (...a: unknown[]) => findActiveMock(...a) },
}));
jest.unstable_mockModule('../src/services/compliance-exemption-service.js', () => ({
  complianceExemptionService: { getActiveExemptionsForEntities: async () => new Map() },
}));
jest.unstable_mockModule('../src/helpers/org-hierarchy-client.js', () => ({ resolveParentOrgId: async () => undefined }));
jest.unstable_mockModule('../src/helpers/compliance-check-log.js', () => ({
  logComplianceCheck: (...a: unknown[]) => logComplianceCheckMock(...a),
}));
jest.unstable_mockModule('../src/helpers/compliance-notifier.js', () => ({
  notifyComplianceBlock: async () => undefined,
  notifyComplianceWarnings: async () => undefined,
}));

const { executeScan, recoverStaleScans } = await import('../src/helpers/scan-executor.js');

function rule(overrides: Record<string, unknown>) {
  return {
    id: 'r',
    name: 'r',
    target: 'plugin',
    severity: 'error',
    scope: 'org',
    priority: 0,
    suppressNotification: false,
    conditions: null,
    effectiveFrom: null,
    effectiveUntil: null,
    ...overrides,
  };
}

/** Canned results for one full single-target scan over `entities`. */
function scanResults(target: string, entities: unknown[]) {
  return [
    [{ id: 'scan-1', orgId: 'org-a', target, status: 'running', triggeredBy: 'manual', userId: 'u-1' }], // claim
    entities, // entity page (short → last page)
    [], // totalEntities update
    [{ status: 'running' }], // cancellation check
    [{ id: 'scan-1' }], // progress update
    [{ id: 'scan-1' }], // completed update
  ];
}

describe('executeScan — evaluates real entity attributes', () => {
  beforeEach(() => {
    rdb.reset();
    logComplianceCheckMock.mockClear();
    findActiveMock.mockReset();
  });

  it('selects full plugin rows and evaluates field rules on them (incl. env keys, values redacted)', async () => {
    findActiveMock.mockResolvedValue([
      rule({ id: 'no-latest', field: 'version', operator: 'neq', value: 'latest' }),
      rule({ id: 'needs-log-level', field: 'env.LOG_LEVEL', operator: 'exists' }),
      // Warning that surfaces the env VALUE as actualValue — must be redacted.
      rule({ id: 'token-shape', severity: 'warning', field: 'env.API_TOKEN', operator: 'eq', value: 'expected' }),
    ]);
    rdb.results.push(...scanResults('plugin', [
      { id: 'p1', orgId: 'org-a', name: 'good', version: '1.2.3', env: { LOG_LEVEL: 'info', API_TOKEN: 'sekret' } },
      { id: 'p2', orgId: 'org-a', name: 'bad', version: 'latest', env: {} },
    ]));

    await executeScan('scan-1');

    // The entity page is a full-row select, not `select "id", "name"`.
    const page = rdb.statements[1];
    expect(page.sql).toContain('from "plugins"');
    expect(page.sql).toContain('"version"');
    expect(page.sql).toContain('"env"');

    const byEntity = new Map(logComplianceCheckMock.mock.calls.map((c) => [c[4], c[6] as any]));
    expect(byEntity.get('p1').blocked).toBe(false);
    expect(byEntity.get('p2').blocked).toBe(true);
    expect(byEntity.get('p2').violations.map((v: { ruleId: string }) => v.ruleId).sort()).toEqual(['needs-log-level', 'no-latest']);
    expect(byEntity.get('p1').warnings[0]).toEqual(expect.objectContaining({ ruleId: 'token-shape', actualValue: '[REDACTED]' }));
    // Display name threaded through; no secret value reaches the evaluation record.
    expect(logComplianceCheckMock.mock.calls.find((c) => c[4] === 'p1')?.[5]).toBe('good');
    expect(JSON.stringify(logComplianceCheckMock.mock.calls)).not.toContain('sekret');

    const completed = rdb.statements[rdb.statements.length - 1];
    expect(completed.params).toEqual(expect.arrayContaining(['completed']));
  });

  it('evaluates pipeline rules on `pipelineName` (the live entity-event field name)', async () => {
    findActiveMock.mockResolvedValue([
      rule({ id: 'prod-prefix', target: 'pipeline', field: 'pipelineName', operator: 'regex', value: '^prod-' }),
    ]);
    rdb.results.push(...scanResults('pipeline', [
      { id: 'pl1', orgId: 'org-a', pipelineName: 'prod-api' },
      { id: 'pl2', orgId: 'org-a', pipelineName: 'scratch' },
    ]));

    await executeScan('scan-1');

    const byEntity = new Map(logComplianceCheckMock.mock.calls.map((c) => [c[4], c[6] as any]));
    expect(byEntity.get('pl1').blocked).toBe(false);
    expect(byEntity.get('pl2').blocked).toBe(true);
    expect(logComplianceCheckMock.mock.calls.find((c) => c[4] === 'pl1')?.[5]).toBe('prod-api');
  });
});

describe('recoverStaleScans', () => {
  beforeEach(() => rdb.reset());

  it('fails only `running` scans started before the stale cutoff (default 2h)', async () => {
    const now = new Date('2026-09-17T12:00:00.000Z');
    rdb.results.push([{ id: 'stuck-1' }, { id: 'stuck-2' }]);

    const recovered = await recoverStaleScans(now);

    expect(recovered).toBe(2);
    const stmt = rdb.statements[0];
    expect(stmt.sql).toMatch(/^update "compliance_scans" set "status" = \$1, "completed_at" = \$2 where \("compliance_scans"\."status" = \$3 and "compliance_scans"\."started_at" < \$4\)/);
    expect(stmt.params[0]).toBe('failed');
    expect(stmt.params[2]).toBe('running');
    expect(new Date(stmt.params[3] as string).toISOString()).toBe('2026-09-17T10:00:00.000Z');
  });

  it('returns 0 when nothing is stale', async () => {
    rdb.results.push([]);
    expect(await recoverStaleScans()).toBe(0);
  });
});
