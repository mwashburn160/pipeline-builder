// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { buildComplianceExemptionConditions, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { paginatedList } from './paginated-list.js';
import type { ActiveExemption } from '../engine/rule-engine.js';

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
    const rows = await withTenantTx(async (tx) => tx
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
      ));

    return rows.map(row => ({ id: row.id, ruleId: row.ruleId }));
  }

  /**
   * Batch variant of {@link getActiveExemptionsForEntity}: active, approved,
   * non-expired exemptions for many entities at once, keyed by entityId. The
   * single source of truth for the active-exemption predicate (the bulk scan
   * executor previously reimplemented this query).
   */
  async getActiveExemptionsForEntities(orgId: string, entityIds: string[]): Promise<Map<string, ActiveExemption[]>> {
    const map = new Map<string, ActiveExemption[]>();
    if (entityIds.length === 0) return map;
    const now = new Date();
    const rows = await withTenantTx(async (tx) => tx
      .select({
        id: schema.complianceExemption.id,
        ruleId: schema.complianceExemption.ruleId,
        entityId: schema.complianceExemption.entityId,
      })
      .from(schema.complianceExemption)
      .where(and(
        eq(schema.complianceExemption.orgId, orgId),
        inArray(schema.complianceExemption.entityId, entityIds),
        eq(schema.complianceExemption.status, 'approved'),
        or(
          isNull(schema.complianceExemption.expiresAt),
          gt(schema.complianceExemption.expiresAt, now),
        ),
      )));
    for (const row of rows) {
      const entityId = row.entityId ?? '';
      const list = map.get(entityId) ?? [];
      list.push({ id: row.id, ruleId: row.ruleId });
      map.set(entityId, list);
    }
    return map;
  }

  /** Paginated list of exemptions filtered by status/rule/entity. */
  async list(filter: ComplianceExemptionFilter, orgId: string, limit: number, offset: number) {
    const conditions = buildComplianceExemptionConditions(filter, orgId);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const { rows, total } = await paginatedList(
      schema.complianceExemption,
      whereClause,
      desc(schema.complianceExemption.createdAt),
      limit,
      offset,
    );
    return { exemptions: rows, total };
  }

  /** Create a single pending exemption request. */
  async create(input: ExemptionInsert, orgId: string, userId: string) {
    const [exemption] = await withTenantTx(async (tx) => tx
      .insert(schema.complianceExemption)
      .values({
        ...input,
        orgId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        status: 'pending',
        createdBy: userId,
        updatedBy: userId,
      })
      .returning());
    return exemption;
  }

  /**
   * Bulk insert exemptions; returns the ids that were actually inserted.
   *
   * Deduped at the DB level: the table carries a unique index on
   * (org_id, rule_id, entity_id) (`compliance_exemption_org_rule_entity_unique`),
   * so `onConflictDoNothing` on that target silently SKIPS any row that collides
   * with an existing exemption — or with an earlier row in the same batch (the
   * index entry for row N is visible to row N+1 within the statement). Without
   * this, a double-submit (or a batch containing the same entity twice) raised a
   * unique-violation and failed the whole insert with a 500. Skipped rows are not
   * returned, so the route derives `skipped = requested - created` from the gap.
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

    const inserted = await withTenantTx(async (tx) => tx
      .insert(schema.complianceExemption)
      .values(rows)
      .onConflictDoNothing({
        target: [
          schema.complianceExemption.orgId,
          schema.complianceExemption.ruleId,
          schema.complianceExemption.entityId,
        ],
      })
      .returning({ id: schema.complianceExemption.id }));

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
    return withTenantTx(async (tx) => {
      const [existing] = await tx
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

      const [updated] = await tx
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
    });
  }

  /** Hard delete an exemption (revoke). */
  async delete(id: string, orgId: string) {
    const [deleted] = await withTenantTx(async (tx) => tx
      .delete(schema.complianceExemption)
      .where(and(
        eq(schema.complianceExemption.id, id),
        eq(schema.complianceExemption.orgId, orgId),
      ))
      .returning());
    return deleted ?? null;
  }
}

export const complianceExemptionService = new ComplianceExemptionService();
