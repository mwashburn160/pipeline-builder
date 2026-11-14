// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComplianceScanStatus, ComplianceScanTarget, ComplianceScanTrigger } from '@pipeline-builder/api-core';
import { buildComplianceScanConditions, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, desc, eq } from 'drizzle-orm';
import { paginatedList } from './paginated-list.js';

export interface ComplianceScanFilter {
  target?: ComplianceScanTarget;
  status?: ComplianceScanStatus;
  triggeredBy?: ComplianceScanTrigger;
}

class ComplianceScanService {
  /** Paginated list of scans for an org. */
  async list(filter: ComplianceScanFilter, orgId: string, limit: number, offset: number) {
    const conditions = buildComplianceScanConditions(filter, orgId);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const { rows, total } = await paginatedList(
      schema.complianceScan,
      whereClause,
      desc(schema.complianceScan.createdAt),
      limit,
      offset,
    );
    return { scans: rows, total };
  }

  /** Single scan by id, scoped to org. Returns null on miss. */
  async findById(id: string, orgId: string) {
    const [scan] = await withTenantTx(async (tx) => tx
      .select()
      .from(schema.complianceScan)
      .where(and(
        eq(schema.complianceScan.id, id),
        eq(schema.complianceScan.orgId, orgId),
      )));
    return scan ?? null;
  }

  /**
   * Create a pending scan record. A scan always evaluates the row's own
   * `orgId` — the executor never reads `filter`, which is only RECORDED (and
   * stamped with the caller's orgId so the stored row cannot name another
   * tenant). It does not narrow what the scan evaluates.
   */
  async create(
    orgId: string,
    userId: string,
    target: ComplianceScanTarget,
    rawFilter: Record<string, unknown> | undefined,
    isDryRun: boolean,
  ) {
    const filter = rawFilter ? { ...rawFilter, orgId } : null;
    const triggeredBy: ComplianceScanTrigger = isDryRun ? 'rule-dry-run' : 'manual';

    const [scan] = await withTenantTx(async (tx) => tx
      .insert(schema.complianceScan)
      .values({
        orgId,
        target,
        filter,
        status: 'pending',
        triggeredBy,
        userId,
      })
      .returning());
    return scan;
  }

  /** Cancel a running scan. Returns the updated row, or null if not found / not running. */
  async cancel(id: string, orgId: string, userId: string) {
    const [updated] = await withTenantTx(async (tx) => tx
      .update(schema.complianceScan)
      .set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: userId })
      .where(and(
        eq(schema.complianceScan.id, id),
        eq(schema.complianceScan.orgId, orgId),
        eq(schema.complianceScan.status, 'running'),
      ))
      .returning());
    return updated ?? null;
  }
}

export const complianceScanService = new ComplianceScanService();
