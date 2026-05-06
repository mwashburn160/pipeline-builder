// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  buildComplianceExemptionConditions,
  db,
  drizzleCount,
  schema,
} from '@pipeline-builder/pipeline-core';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { ActiveExemption } from '../engine/rule-engine';

export const CE_NOT_FOUND = 'CE_NOT_FOUND';
export const CE_SELF_APPROVE = 'CE_SELF_APPROVE';

export interface ComplianceExemptionFilter {
  ruleId?: string;
  entityType?: 'plugin' | 'pipeline';
  entityId?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
}

interface ExemptionInsert {
  ruleId: string;
  entityType: 'plugin' | 'pipeline';
  entityId: string;
  entityName?: string;
  reason: string;
  expiresAt?: string;
}

class ComplianceExemptionService {
  /**
   * Active, approved, non-expired exemptions for an entity. Used by the
   * rule engine to skip rules that have been waived for this entity.
   */
  async getActiveExemptionsForEntity(orgId: string, entityId: string): Promise<ActiveExemption[]> {
    const now = new Date();
    const rows = await db
      .select({
        id: schema.complianceExemption.id,
        ruleId: schema.complianceExemption.ruleId,
      })
      .from(schema.complianceExemption)
      .where(
        and(
          eq(schema.complianceExemption.orgId, orgId),
          eq(schema.complianceExemption.entityId, entityId),
          eq(schema.complianceExemption.status, 'approved'),
          or(
            isNull(schema.complianceExemption.expiresAt),
            gt(schema.complianceExemption.expiresAt, now),
          ),
        ),
      );

    return rows.map(row => ({ id: row.id, ruleId: row.ruleId }));
  }

  /** Paginated list of exemptions filtered by status/rule/entity. */
  async list(filter: ComplianceExemptionFilter, orgId: string, limit: number, offset: number) {
    const conditions = buildComplianceExemptionConditions(filter, orgId);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.complianceExemption)
      .where(whereClause)
      .then(r => drizzleCount(r));

    const exemptions = await db
      .select()
      .from(schema.complianceExemption)
      .where(whereClause)
      .orderBy(desc(schema.complianceExemption.createdAt))
      .limit(limit)
      .offset(offset);

    return { exemptions, total: countResult?.count ?? 0 };
  }

  /** Create a single pending exemption request. */
  async create(input: ExemptionInsert, orgId: string, userId: string) {
    const [exemption] = await db
      .insert(schema.complianceExemption)
      .values({
        ...input,
        orgId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        status: 'pending',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    return exemption;
  }

  /**
   * Bulk insert exemptions; returns count + ids. The schema lacks a unique
   * constraint to dedupe (ruleId, entityType, entityId, status='pending'),
   * so callers should be prepared for duplicates if double-submitted.
   */
  async bulkCreate(inputs: ExemptionInsert[], orgId: string, userId: string) {
    const rows = inputs.map(e => ({
      ...e,
      orgId,
      expiresAt: e.expiresAt ? new Date(e.expiresAt) : null,
      status: 'pending' as const,
      createdBy: userId,
      updatedBy: userId,
    }));

    const inserted = await db
      .insert(schema.complianceExemption)
      .values(rows)
      .returning({ id: schema.complianceExemption.id });

    return inserted.map(r => r.id);
  }

  /**
   * Approve or reject a pending exemption. Refuses self-approval (the
   * approver cannot be the requester); rejection is allowed.
   */
  async review(
    id: string,
    orgId: string,
    reviewerId: string,
    decision: 'approved' | 'rejected',
    rejectionReason?: string,
  ) {
    const [existing] = await db
      .select({ createdBy: schema.complianceExemption.createdBy })
      .from(schema.complianceExemption)
      .where(and(
        eq(schema.complianceExemption.id, id),
        eq(schema.complianceExemption.orgId, orgId),
        eq(schema.complianceExemption.status, 'pending'),
      ));

    if (!existing) throw new Error(CE_NOT_FOUND);
    if (decision === 'approved' && existing.createdBy === reviewerId) {
      throw new Error(CE_SELF_APPROVE);
    }

    const [updated] = await db
      .update(schema.complianceExemption)
      .set({
        status: decision,
        approvedBy: decision === 'approved' ? reviewerId : undefined,
        rejectionReason: rejectionReason ?? null,
        updatedBy: reviewerId,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.complianceExemption.id, id),
        eq(schema.complianceExemption.orgId, orgId),
        eq(schema.complianceExemption.status, 'pending'),
      ))
      .returning();

    if (!updated) throw new Error(CE_NOT_FOUND);
    return updated;
  }

  /** Hard delete an exemption (revoke). */
  async delete(id: string, orgId: string) {
    const [deleted] = await db
      .delete(schema.complianceExemption)
      .where(and(
        eq(schema.complianceExemption.id, id),
        eq(schema.complianceExemption.orgId, orgId),
      ))
      .returning();
    return deleted ?? null;
  }
}

export const complianceExemptionService = new ComplianceExemptionService();
