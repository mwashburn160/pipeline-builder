// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { buildComplianceAuditConditions, schema } from '@pipeline-builder/pipeline-data';
import { and, desc } from 'drizzle-orm';
import { paginatedList } from './paginated-list.js';

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

    const { rows, total } = await paginatedList(
      schema.complianceAuditLog,
      whereClause,
      desc(schema.complianceAuditLog.createdAt),
      limit,
      offset,
    );
    return { entries: rows, total };
  }
}

export const complianceAuditService = new ComplianceAuditService();
