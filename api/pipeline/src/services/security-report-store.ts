// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage for application-artifact security reports — the LATEST report per
 * (pipeline, tool, stage). One row per slot, replaced on every upload: the
 * scorecard and the security panel answer "what does the pipeline's own scan
 * say NOW", and history would only grow a table nobody reads.
 *
 * Table `pipeline_security_reports` (DDL in postgres-init.sql):
 *   id varchar(255) PK, org_id varchar(255) NOT NULL, pipeline_id varchar(255) NOT NULL,
 *   tool varchar(64) NOT NULL, format varchar(16) NOT NULL, stage varchar(255) NOT NULL DEFAULT '',
 *   execution_id varchar(255) NULL, critical_count/high_count/medium_count/low_count/kev_count/
 *   critical_fixable/high_fixable integer NOT NULL DEFAULT 0, findings jsonb NOT NULL DEFAULT '[]',
 *   truncated boolean NOT NULL DEFAULT false, submitted_by varchar(255) NOT NULL,
 *   created_at timestamptz NOT NULL DEFAULT now(),
 *   UNIQUE (pipeline_id, tool, stage), tenant RLS on org_id like the other reporting tables.
 *
 * Behind an interface so the routes and the scorecard are tested against an
 * in-memory double.
 */

import { randomUUID } from 'node:crypto';
import type { SecurityReportFormat } from '@pipeline-builder/pipeline-core';
import { withTenantTx } from '@pipeline-builder/pipeline-data';
import { sql } from 'drizzle-orm';
import type { ArtifactFinding, SeverityCounts } from '../helpers/security-report.js';

/** One stored report (the latest for its slot). */
export interface StoredSecurityReport {
  id: string;
  orgId: string;
  pipelineId: string;
  tool: string;
  format: SecurityReportFormat;
  /** `''` when the upload named no stage. */
  stage: string;
  executionId: string | null;
  counts: SeverityCounts;
  findings: ArtifactFinding[];
  truncated: boolean;
  submittedBy: string;
  createdAt: Date;
}

export type SecurityReportInput = Omit<StoredSecurityReport, 'id' | 'createdAt'>;

/** A stored report without its findings — what a roll-up that only sums counts reads. */
export type SecurityReportSummary = Omit<StoredSecurityReport, 'findings'>;

export interface SecurityReportStore {
  /** Replace the slot's report; returns the stored row. */
  put(input: SecurityReportInput): Promise<StoredSecurityReport>;
  /** The latest report per (tool, stage) of each pipeline, newest first. */
  latest(orgId: string, pipelineIds: readonly string[]): Promise<StoredSecurityReport[]>;
  /**
   * {@link latest} WITHOUT the `findings` jsonb — the scorecard roll-up reads up
   * to a page of pipelines and only sums counts, so it must not pull every
   * report's findings off disk to throw them away.
   */
  latestSummaries(orgId: string, pipelineIds: readonly string[]): Promise<SecurityReportSummary[]>;
  /**
   * Remove one (tool, stage) slot of a pipeline — a scanner the pipeline no
   * longer runs, or a renamed stage, whose last counts would otherwise feed the
   * scorecard forever. Returns the removed row, or null when there was none.
   */
  remove(orgId: string, pipelineId: string, tool: string, stage: string): Promise<SecurityReportSummary | null>;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

function toSummary(r: Record<string, unknown>): SecurityReportSummary {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    pipelineId: String(r.pipeline_id),
    tool: String(r.tool),
    format: r.format as SecurityReportFormat,
    stage: String(r.stage ?? ''),
    executionId: (r.execution_id as string | null) ?? null,
    counts: {
      critical: num(r.critical_count),
      high: num(r.high_count),
      medium: num(r.medium_count),
      low: num(r.low_count),
      kev: num(r.kev_count),
      criticalFixable: num(r.critical_fixable),
      highFixable: num(r.high_fixable),
    },
    truncated: r.truncated === true,
    submittedBy: String(r.submitted_by),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at)),
  };
}

function toStored(r: Record<string, unknown>): StoredSecurityReport {
  return { ...toSummary(r), findings: (Array.isArray(r.findings) ? r.findings : []) as ArtifactFinding[] };
}

/** Every column but `findings` (the summary read). */
const SUMMARY_COLUMNS = sql.raw(`id, org_id, pipeline_id, tool, format, stage, execution_id,
  critical_count, high_count, medium_count, low_count, kev_count, critical_fixable, high_fixable,
  truncated, submitted_by, created_at`);

const rowsOf = (result: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? [])) as Array<Record<string, unknown>>;

export const drizzleSecurityReportStore: SecurityReportStore = {
  async put(input) {
    const c = input.counts;
    const result = await withTenantTx((tx) => tx.execute(sql`
      INSERT INTO pipeline_security_reports
        (id, org_id, pipeline_id, tool, format, stage, execution_id,
         critical_count, high_count, medium_count, low_count, kev_count, critical_fixable, high_fixable,
         findings, truncated, submitted_by, created_at)
      VALUES
        (${randomUUID()}, ${input.orgId}, ${input.pipelineId}, ${input.tool}, ${input.format}, ${input.stage}, ${input.executionId},
         ${c.critical}, ${c.high}, ${c.medium}, ${c.low}, ${c.kev}, ${c.criticalFixable}, ${c.highFixable},
         ${JSON.stringify(input.findings)}::jsonb, ${input.truncated}, ${input.submittedBy}, now())
      ON CONFLICT (pipeline_id, tool, stage) DO UPDATE SET
        format = EXCLUDED.format, execution_id = EXCLUDED.execution_id,
        critical_count = EXCLUDED.critical_count, high_count = EXCLUDED.high_count,
        medium_count = EXCLUDED.medium_count, low_count = EXCLUDED.low_count, kev_count = EXCLUDED.kev_count,
        critical_fixable = EXCLUDED.critical_fixable, high_fixable = EXCLUDED.high_fixable,
        findings = EXCLUDED.findings, truncated = EXCLUDED.truncated,
        submitted_by = EXCLUDED.submitted_by, created_at = EXCLUDED.created_at
      RETURNING *
    `));
    return toStored(rowsOf(result)[0]!);
  },

  async latest(orgId, pipelineIds) {
    if (pipelineIds.length === 0) return [];
    const result = await withTenantTx((tx) => tx.execute(sql`
      SELECT * FROM pipeline_security_reports
      WHERE org_id = ${orgId} AND pipeline_id IN (${sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY created_at DESC
    `));
    return rowsOf(result).map(toStored);
  },

  async latestSummaries(orgId, pipelineIds) {
    if (pipelineIds.length === 0) return [];
    const result = await withTenantTx((tx) => tx.execute(sql`
      SELECT ${SUMMARY_COLUMNS} FROM pipeline_security_reports
      WHERE org_id = ${orgId} AND pipeline_id IN (${sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY created_at DESC
    `));
    return rowsOf(result).map(toSummary);
  },

  async remove(orgId, pipelineId, tool, stage) {
    const result = await withTenantTx((tx) => tx.execute(sql`
      DELETE FROM pipeline_security_reports
      WHERE org_id = ${orgId} AND pipeline_id = ${pipelineId} AND tool = ${tool} AND stage = ${stage}
      RETURNING ${SUMMARY_COLUMNS}
    `));
    const row = rowsOf(result)[0];
    return row ? toSummary(row) : null;
  },
};

let store: SecurityReportStore = drizzleSecurityReportStore;

/** The active store. */
export function securityReportStore(): SecurityReportStore {
  return store;
}

/** Test hook: replace the store (null restores the database one). */
export function setSecurityReportStoreForTests(s: SecurityReportStore | null): void {
  store = s ?? drizzleSecurityReportStore;
}

/** An in-memory store, for tests. */
export function memorySecurityReportStore(): SecurityReportStore & { rows: StoredSecurityReport[] } {
  const rows: StoredSecurityReport[] = [];
  return {
    rows,
    async put(input) {
      const i = rows.findIndex((r) => r.pipelineId === input.pipelineId && r.tool === input.tool && r.stage === input.stage);
      const row: StoredSecurityReport = { ...input, id: i >= 0 ? rows[i]!.id : randomUUID(), createdAt: new Date() };
      if (i >= 0) rows.splice(i, 1);
      rows.unshift(row);
      return row;
    },
    async latest(orgId, pipelineIds) {
      return rows.filter((r) => r.orgId === orgId && pipelineIds.includes(r.pipelineId));
    },
    async latestSummaries(orgId, pipelineIds) {
      return rows
        .filter((r) => r.orgId === orgId && pipelineIds.includes(r.pipelineId))
        .map(({ findings: _findings, ...summary }) => summary);
    },
    async remove(orgId, pipelineId, tool, stage) {
      const i = rows.findIndex((r) => r.orgId === orgId && r.pipelineId === pipelineId && r.tool === tool && r.stage === stage);
      if (i < 0) return null;
      const [{ findings: _findings, ...summary }] = rows.splice(i, 1) as [StoredSecurityReport];
      return summary;
    },
  };
}

/** Roll-up of a pipeline's latest reports: summed counts, and the reports' freshest time. */
export function summarizeReports(reports: readonly SecurityReportSummary[]): { counts: SeverityCounts; reports: number; latestAt: Date | null } {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, kev: 0, criticalFixable: 0, highFixable: 0 };
  let latestAt: Date | null = null;
  for (const r of reports) {
    for (const k of Object.keys(counts) as Array<keyof SeverityCounts>) counts[k] += r.counts[k];
    if (!latestAt || r.createdAt > latestAt) latestAt = r.createdAt;
  }
  return { counts, reports: reports.length, latestAt };
}
