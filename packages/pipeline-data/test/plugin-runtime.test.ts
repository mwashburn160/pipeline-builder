// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-plugin runtime telemetry (plugin-ecosystem W0.1):
 *   - ingest stamps plugin_publisher/name/version onto action events from the
 *     pipeline's step manifest, with ONE manifest read per batch;
 *   - the runtime report / ecosystem aggregate / verified-use reads build the
 *     SQL they claim to (rendered via drizzle's PgDialect — no live Postgres in
 *     this jest-ESM setup) and run under the tenant context they claim to.
 */

import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiCoreMock, cacheKeyLog } from './helpers/mock-api-core.js';

const mockExecute = jest.fn<AnyFn>();
const mockInsert = jest.fn<AnyFn>();
const mockSelect = jest.fn<AnyFn>();
const tenantContexts: unknown[] = [];

jest.unstable_mockModule('../src/database/postgres-connection.js', () => ({
  db: { execute: mockExecute, insert: mockInsert, select: mockSelect },
}));

jest.unstable_mockModule('../src/database/tenancy.js', () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) => fn({ execute: mockExecute, insert: mockInsert, select: mockSelect }),
  runWithTenantContext: <T>(ctx: unknown, fn: () => T) => { tenantContexts.push(ctx); return fn(); },
  getTenantContext: () => undefined,
  tenantContext: { run: <T>(_ctx: unknown, fn: () => T) => fn(), getStore: () => undefined },
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const { ReportingService } = await import('../src/api/reporting-service.js');
const { schema } = await import('../src/database/drizzle-schema.js');

const dialect = new PgDialect();
function rendered(callIndex = 0): { sql: string; params: unknown[] } {
  const arg = mockExecute.mock.calls[callIndex]?.[0] as SQL | undefined;
  if (!arg) throw new Error(`tx.execute was not called (index ${callIndex})`);
  return dialect.sqlToQuery(arg);
}

describe('plugin runtime telemetry', () => {
  let service: InstanceType<typeof ReportingService>;

  beforeEach(() => {
    jest.clearAllMocks();
    tenantContexts.length = 0;
    cacheKeyLog.length = 0;
    service = new ReportingService();
  });

  describe('ingestEvents — step-manifest join', () => {
    /** select #1 = registry rows, select #2 = manifest rows. Captures the insert batch. */
    function wire(registry: Array<Record<string, unknown>>, manifest: Array<Record<string, unknown>>) {
      const from = jest.fn<AnyFn>()
        .mockReturnValueOnce({ where: jest.fn<AnyFn>().mockResolvedValue(registry) })
        .mockReturnValueOnce({ where: jest.fn<AnyFn>().mockResolvedValue(manifest) });
      mockSelect.mockReturnValue({ from });
      let captured: Array<Record<string, unknown>> = [];
      mockInsert.mockReturnValue({
        values: jest.fn<AnyFn>().mockImplementation((rows: Array<Record<string, unknown>>) => {
          captured = rows;
          return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) };
        }),
      });
      return { from, rows: () => captured };
    }

    const manifestRow = (over: Record<string, unknown> = {}) => ({
      pipelineId: 'pl-1',
      orgId: 'acme',
      stageName: 'test-wave',
      actionName: 'jest',
      pluginPublisher: 'pipeline-builder',
      pluginPublisherId: 'pub-official',
      pluginName: 'jest',
      pluginVersion: '2.0.0',
      ...over,
    });

    it('stamps the manifest plugin onto matching ACTION events, reading the manifest once per batch', async () => {
      const w = wire(
        [{ pipelineId: 'pl-1', orgId: 'acme' }, { pipelineId: 'pl-2', orgId: 'acme' }],
        [manifestRow(), manifestRow({ pipelineId: 'pl-2', actionName: 'lint', pluginPublisher: null, pluginPublisherId: null, pluginName: 'lint', pluginVersion: '1.0.0' })],
      );

      await service.ingestEvents([
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'ACTION', status: 'SUCCEEDED', executionId: 'x1', stageName: 'test-wave', actionName: 'jest' },
        { pipelineId: 'pl-2', eventSource: 'codepipeline', eventType: 'ACTION', status: 'FAILED', executionId: 'x2', stageName: 'test-wave', actionName: 'lint' },
        // Not in the manifest (e.g. the Source action) → no attribution.
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'ACTION', status: 'SUCCEEDED', executionId: 'x1', stageName: 'Source', actionName: 'GitHub' },
        // STAGE events are never attributed, even when the names would match.
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'STAGE', status: 'SUCCEEDED', executionId: 'x1', stageName: 'test-wave', actionName: 'jest' },
      ]);

      expect(w.from).toHaveBeenCalledTimes(2); // registry + ONE manifest read
      expect(w.from).toHaveBeenLastCalledWith(schema.pipelineStepManifest);
      const plugins = w.rows().map((r) => [r.pluginPublisher, r.pluginPublisherId, r.pluginName, r.pluginVersion]);
      expect(plugins).toEqual([
        ['pipeline-builder', 'pub-official', 'jest', '2.0.0'],
        [null, null, 'lint', '1.0.0'],
        [null, null, null, null],
        [null, null, null, null],
      ]);
    });

    it('joins on the SCRUBBED names (the manifest stores them scrubbed the same way)', async () => {
      const w = wire(
        [{ pipelineId: 'pl-1', orgId: 'acme' }],
        [manifestRow({ stageName: 'deploy-[REDACTED]' })],
      );
      await service.ingestEvents([
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'ACTION', status: 'SUCCEEDED', executionId: 'x1', stageName: 'deploy-123456789012', actionName: 'jest' },
      ]);
      expect(w.rows()[0]).toEqual(expect.objectContaining({ stageName: 'deploy-[REDACTED]', pluginName: 'jest' }));
    });

    it('ignores a manifest row whose org differs from the registry-resolved org', async () => {
      const w = wire([{ pipelineId: 'pl-1', orgId: 'acme' }], [manifestRow({ orgId: 'evil' })]);
      await service.ingestEvents([
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'ACTION', status: 'SUCCEEDED', executionId: 'x1', stageName: 'test-wave', actionName: 'jest' },
      ]);
      expect(w.rows()[0].pluginName).toBeNull();
    });

    it('skips the manifest read entirely when no event is attributable', async () => {
      const w = wire([{ pipelineId: 'pl-1', orgId: 'acme' }], []);
      await service.ingestEvents([
        { pipelineId: 'pl-1', eventSource: 'codepipeline', eventType: 'PIPELINE', status: 'SUCCEEDED', executionId: 'x1' },
      ]);
      expect(w.from).toHaveBeenCalledTimes(1);
    });
  });

  describe('getPluginRuntime', () => {
    const FROM = '2026-09-01T00:00:00Z';
    const TO = '2026-09-21T00:00:00Z';

    it('aggregates terminal plugin-attributed ACTION runs per version with p50/p95', async () => {
      const rows = [{ pluginPublisher: null, pluginName: 'jest', pluginVersion: '2.0.0', runs: 4, succeeded: 3, failed: 1, successPct: 75, p50Ms: 1000, p95Ms: 4000, lastRun: TO }];
      mockExecute.mockResolvedValue({ rows });

      await expect(service.getPluginRuntime('acme', FROM, TO)).resolves.toEqual(rows);
      const { sql, params } = rendered();
      expect(sql).toContain("e.event_type = 'ACTION' AND e.plugin_name IS NOT NULL");
      expect(sql).toContain("e.status IN ('SUCCEEDED', 'FAILED')");
      expect(sql).toContain('PERCENTILE_CONT(0.5)');
      expect(sql).toContain('PERCENTILE_CONT(0.95)');
      expect(sql).toContain('GROUP BY e.plugin_publisher, e.plugin_name, e.plugin_version');
      expect(sql).not.toContain('e.plugin_version =');
      expect(params).toEqual(expect.arrayContaining(['acme', FROM, TO]));
    });

    it('applies name / publisher / version filters, and publisher:null selects own-org plugins', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getPluginRuntime('acme', FROM, TO, { name: 'jest', publisher: 'pipeline-builder', version: '2.0.0' });
      const first = rendered(0);
      expect(first.sql).toContain('e.plugin_name = $');
      expect(first.sql).toContain('e.plugin_publisher = $');
      expect(first.sql).toContain('e.plugin_version = $');
      expect(first.params).toEqual(expect.arrayContaining(['jest', 'pipeline-builder', '2.0.0']));

      await service.getPluginRuntime('acme', FROM, TO, { publisher: null });
      expect(rendered(1).sql).toContain('e.plugin_publisher IS NULL');
      // Distinct filters ⇒ distinct cache entries.
      expect(new Set(cacheKeyLog).size).toBe(2);
    });

    it('rolls up an org subtree under sysadmin context', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await service.getPluginRuntime('acme', FROM, TO, {}, ['acme', 'acme-team']);
      expect(rendered().sql).toContain('e.org_id IN (');
      expect(tenantContexts).toEqual([{ isSuperAdmin: true }]);
    });
  });

  describe('getPluginRuntimeAggregate', () => {
    it('reads every org (system context) over the 30-day window', async () => {
      mockExecute.mockResolvedValue({ rows: [{ runs30d: 10, successRate30d: 0.9, activeOrgCount30d: 3 }] });
      await expect(service.getPluginRuntimeAggregate('pipeline-builder', 'jest'))
        .resolves.toEqual({ runs30d: 10, successRate30d: 0.9, activeOrgCount30d: 3 });
      const { sql, params } = rendered();
      expect(sql).toContain('COUNT(DISTINCT e.org_id)');
      expect(sql).not.toContain('e.org_id =');
      expect(params).toEqual(expect.arrayContaining(['pipeline-builder', 'jest', 30]));
      expect(tenantContexts).toEqual([{ isSuperAdmin: true }]);
    });

    it('defaults to zero runs / null rate when the query yields nothing', async () => {
      mockExecute.mockResolvedValue({ rows: [] });
      await expect(service.getPluginRuntimeAggregate('acme', 'x'))
        .resolves.toEqual({ runs30d: 0, successRate30d: null, activeOrgCount30d: 0 });
    });
  });

  describe('hasVerifiedPluginUse', () => {
    it('checks for a SUCCEEDED run by that org within 90 days, under the org\'s own RLS scope', async () => {
      mockExecute.mockResolvedValue({ rows: [{ verified: true }] });
      await expect(service.hasVerifiedPluginUse('acme', 'pipeline-builder', 'jest')).resolves.toBe(true);
      const { sql, params } = rendered();
      expect(sql).toContain("e.status = 'SUCCEEDED'");
      expect(sql).toContain('e.org_id = $');
      expect(params).toEqual(expect.arrayContaining(['acme', 'pipeline-builder', 'jest', 90]));
      expect(tenantContexts).toEqual([{ orgId: 'acme', isSuperAdmin: false }]);
    });

    it('is false when no such run exists', async () => {
      mockExecute.mockResolvedValue({ rows: [{ verified: false }] });
      await expect(service.hasVerifiedPluginUse('acme', 'pipeline-builder', 'jest')).resolves.toBe(false);
    });
  });
});
