// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  buildComplianceScanConditions,
  db,
  drizzleCount,
  schema,
} from '@pipeline-builder/pipeline-core';
import { and, desc, eq, sql } from 'drizzle-orm';

export interface ComplianceScanFilter {
  target?: 'plugin' | 'pipeline' | 'all';
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggeredBy?: 'manual' | 'scheduled' | 'rule-change' | 'rule-dry-run';
}

class ComplianceScanService {
  /** Paginated list of scans for an org. */
  async list(filter: ComplianceScanFilter, orgId: string, limit: number, offset: number) {
    const conditions = buildComplianceScanConditions(filter, orgId);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceScan)
      .where(whereClause)
      .then(r => drizzleCount(r));

    const scans = await db
      .select()
      .from(schema.complianceScan)
      .where(whereClause)
      .orderBy(desc(schema.complianceScan.createdAt))
      .limit(limit)
      .offset(offset);

    return { scans, total: countResult?.count ?? 0 };
  }

  /** Single scan by id, scoped to org. Returns null on miss. */
  async findById(id: string, orgId: string) {
    const [scan] = await db
      .select()
      .from(schema.complianceScan)
      .where(and(
        eq(schema.complianceScan.id, id),
        eq(schema.complianceScan.orgId, orgId),
      ));
    return scan ?? null;
  }

  /**
   * Create a pending scan record. Caller-supplied filter is force-scoped to
   * the caller's orgId to prevent cross-tenant scan triggering via
   * `filter: { orgId: 'other-org' }`.
   */
  async create(
    orgId: string,
    userId: string,
    target: 'plugin' | 'pipeline' | 'all',
    rawFilter: Record<string, unknown> | undefined,
    isDryRun: boolean,
  ) {
    const filter = rawFilter ? { ...rawFilter, orgId } : null;
    const triggeredBy = isDryRun ? 'rule-dry-run' : 'manual';

    const [scan] = await db
      .insert(schema.complianceScan)
      .values({
        orgId,
        target,
        filter,
        status: 'pending',
        triggeredBy,
        userId,
      })
      .returning();
    return scan;
  }

  /** Cancel a running scan. Returns the updated row, or null if not found / not running. */
  async cancel(id: string, orgId: string, userId: string) {
    const [updated] = await db
      .update(schema.complianceScan)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: userId })
      .where(and(
        eq(schema.complianceScan.id, id),
        eq(schema.complianceScan.orgId, orgId),
        eq(schema.complianceScan.status, 'running'),
      ))
      .returning();
    return updated ?? null;
  }
}

export const complianceScanService = new ComplianceScanService();
