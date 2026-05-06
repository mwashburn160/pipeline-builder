// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  buildComplianceAuditConditions,
  db,
  drizzleCount,
  schema,
} from '@pipeline-builder/pipeline-core';
import { and, desc, sql } from 'drizzle-orm';

export interface ComplianceAuditFilter {
  target?: 'plugin' | 'pipeline';
  action?: string;
  result?: 'pass' | 'warn' | 'block';
  scanId?: string;
  dateFrom?: string;
  dateTo?: string;
}

class ComplianceAuditService {
  /** Paginated list of audit log entries scoped to the org. */
  async list(filter: ComplianceAuditFilter, orgId: string, limit: number, offset: number) {
    const conditions = buildComplianceAuditConditions(filter, orgId);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceAuditLog)
      .where(whereClause)
      .then(r => drizzleCount(r));

    const entries = await db
      .select()
      .from(schema.complianceAuditLog)
      .where(whereClause)
      .orderBy(desc(schema.complianceAuditLog.createdAt))
      .limit(limit)
      .offset(offset);

    return { entries, total: countResult?.count ?? 0 };
  }
}

export const complianceAuditService = new ComplianceAuditService();
