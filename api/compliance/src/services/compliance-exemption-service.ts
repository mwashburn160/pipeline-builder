// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComplianceExemptionDecision, ComplianceExemptionRequest, ComplianceExemptionStatus, RuleTarget } from '@pipeline-builder/api-core';
import { buildComplianceExemptionConditions, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { paginatedList } from './paginated-list.js';
import type { ActiveExemption } from '../engine/rule-engine.js';

export const CE_NOT_FOUND = 'CE_NOT_FOUND';
export const CE_SELF_APPROVE = 'CE_SELF_APPROVE';
export const CE_ALREADY_EXISTS = 'CE_ALREADY_EXISTS';
/** The exemption is not approved-and-in-force, or has no expiry to extend. */
export const CE_NOT_EXTENDABLE = 'CE_NOT_EXTENDABLE';
/** The requested expiry is not in the future, or not later than the current one. */
export const CE_EXPIRY_NOT_LATER = 'CE_EXPIRY_NOT_LATER';

/** Entity ids per batched exemption lookup — far under Postgres's bind-parameter cap. */
export const EXEMPTION_LOOKUP_CHUNK = 5000;

export interface ComplianceExemptionFilter {
  ruleId?: string;
  entityType?: RuleTarget;
  entityId?: string;
  status?: ComplianceExemptionStatus;
}

/** The insert shape IS the `POST /compliance/exemptions` wire contract; it is
 *  shared with the Ask agent's proposal so the two cannot drift. */
type ExemptionInsert = ComplianceExemptionRequest;

/** Closed decisions a new request for the same (rule, entity) may reopen. */
const REOPENABLE_STATUSES: ComplianceExemptionStatus[] = ['rejected', 'expired'];

/**
 * The conflict clause both create paths share, on the (org, rule, entity)
 * unique index. A collision with a LIVE request (pending, or approved and in
 * force) is skipped — the dedupe. A collision with a CLOSED one (rejected,
 * expired by the sweep, or approved with an `expiresAt` already past — lapsed
 * but not yet swept, which the active-exemption predicate already ignores)
 * REOPENS that row as a fresh pending request from the new requester: the index
 * allows one row per triple, so with `DO NOTHING` alone an exemption that lapsed
 * could never be requested again. Every decision-bearing column is reset;
 * `createdBy` becomes the new requester so the self-approval check binds on the
 * person asking now, and `createdAt` moves to now so the reopened request lists
 * as the new request it is rather than under its original filing date.
 */
function reopenClosedRequest(now: Date) {
  return {
    target: [
      schema.complianceExemption.orgId,
      schema.complianceExemption.ruleId,
      schema.complianceExemption.entityId,
    ],
    set: {
      status: 'pending' as const,
      entityType: sql`excluded.entity_type`,
      entityName: sql`excluded.entity_name`,
      reason: sql`excluded.reason`,
      expiresAt: sql`excluded.expires_at`,
      createdBy: sql`excluded.created_by`,
      updatedBy: sql`excluded.updated_by`,
      approvedBy: null,
      rejectionReason: null,
      expiryWarnedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    setWhere: or(
      inArray(schema.complianceExemption.status, REOPENABLE_STATUSES),
      and(
        eq(schema.complianceExemption.status, 'approved'),
        lte(schema.complianceExemption.expiresAt, now),
      ),
    ),
  };
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
   * executor reads through it too).
   *
   * Queried in chunks of {@link EXEMPTION_LOOKUP_CHUNK} ids: a scan hands over
   * every entity of its target (up to `COMPLIANCE_SCAN_ENTITY_MAX_TOTAL`, 100k by
   * default), and one `IN (...)` past Postgres's 65535 bind parameters fails the
   * query — and with it the whole scan — for any org that large.
   */
  async getActiveExemptionsForEntities(orgId: string, entityIds: string[]): Promise<Map<string, ActiveExemption[]>> {
    const map = new Map<string, ActiveExemption[]>();
    const now = new Date();
    for (let i = 0; i < entityIds.length; i += EXEMPTION_LOOKUP_CHUNK) {
      const chunk = entityIds.slice(i, i + EXEMPTION_LOOKUP_CHUNK);
      const rows = await withTenantTx(async (tx) => tx
        .select({
          id: schema.complianceExemption.id,
          ruleId: schema.complianceExemption.ruleId,
          entityId: schema.complianceExemption.entityId,
        })
        .from(schema.complianceExemption)
        .where(and(
          eq(schema.complianceExemption.orgId, orgId),
          inArray(schema.complianceExemption.entityId, chunk),
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

  /**
   * Create a single pending exemption request.
   *
   * Deduped at the DB level like {@link bulkCreate}: a collision with a live
   * request on the (org_id, rule_id, entity_id) unique index
   * (`compliance_exemption_org_rule_entity_unique`) is skipped, which comes back
   * as an empty `returning()`; we translate that to the `CE_ALREADY_EXISTS`
   * sentinel so the route returns a clean 409 instead of a unique-violation 500.
   * A collision with a rejected, expired or lapsed request reopens it
   * ({@link reopenClosedRequest}).
   */
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
      .onConflictDoUpdate(reopenClosedRequest(new Date()))
      .returning());
    if (!exemption) throw new Error(CE_ALREADY_EXISTS);
    return exemption;
  }

  /**
   * Bulk insert exemptions; returns the ids that were actually inserted or
   * reopened.
   *
   * Deduped on the (org_id, rule_id, entity_id) unique index exactly as
   * {@link create}: a row colliding with a live request is skipped, one
   * colliding with a rejected/expired/lapsed request reopens it. Repeats WITHIN the
   * batch are dropped here first (first one wins) — `ON CONFLICT DO UPDATE`
   * refuses to touch the same row twice in one statement, so a double-submitted
   * entity would otherwise fail the whole insert. Skipped rows are not
   * returned, so the route derives `skipped = requested - created` from the gap.
   */
  async bulkCreate(inputs: ExemptionInsert[], orgId: string, userId: string) {
    const seen = new Set<string>();
    const rows = inputs
      .filter((e) => {
        // Lowercased: the ids are `uuid` columns, so `ABC…` and `abc…` are the
        // same row to Postgres, and a case-only repeat would otherwise reach the
        // statement twice and fail the whole batch.
        const key = `${e.ruleId}|${e.entityId}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(e => ({
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
      .onConflictDoUpdate(reopenClosedRequest(new Date()))
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
    decision: ComplianceExemptionDecision,
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

  /**
   * Extend an APPROVED, still-in-force exemption's `expiresAt`. The unique
   * (org, rule, entity) index holds the approved row until it lapses, so a
   * fresh request cannot renew it — this is the renewal. It is a second
   * approval of a longer waiver, so it binds the same two-person rule as
   * {@link review}: the requester cannot extend their own exemption.
   *
   * Refuses (CE_NOT_EXTENDABLE) a row that is not approved, has already lapsed
   * (re-request it instead), or carries no expiry; refuses
   * (CE_EXPIRY_NOT_LATER) a new expiry that is not both in the future and later
   * than the current one. `expiryWarnedAt` is cleared so the lapse warning
   * fires again ahead of the new date. Returns the updated row and the expiry
   * it replaced.
   */
  async extendExpiry(id: string, orgId: string, reviewerId: string, expiresAt: Date) {
    const now = new Date();
    if (!(expiresAt.getTime() > now.getTime())) throw new Error(CE_EXPIRY_NOT_LATER);
    return withTenantTx(async (tx) => {
      const [existing] = await tx
        .select({
          createdBy: schema.complianceExemption.createdBy,
          status: schema.complianceExemption.status,
          expiresAt: schema.complianceExemption.expiresAt,
        })
        .from(schema.complianceExemption)
        .where(and(
          eq(schema.complianceExemption.id, id),
          eq(schema.complianceExemption.orgId, orgId),
        ));

      if (!existing) throw new Error(CE_NOT_FOUND);
      const current = existing.expiresAt;
      if (existing.status !== 'approved' || !current || current.getTime() <= now.getTime()) {
        throw new Error(CE_NOT_EXTENDABLE);
      }
      if (existing.createdBy === reviewerId) throw new Error(CE_SELF_APPROVE);
      if (expiresAt.getTime() <= current.getTime()) throw new Error(CE_EXPIRY_NOT_LATER);

      // Guarded on the expiry read above: a concurrent extension, revoke or
      // the expiry sweep turns this into a no-match instead of a lost write.
      const [updated] = await tx
        .update(schema.complianceExemption)
        .set({
          expiresAt,
          approvedBy: reviewerId,
          expiryWarnedAt: null,
          updatedBy: reviewerId,
          updatedAt: now,
        })
        .where(and(
          eq(schema.complianceExemption.id, id),
          eq(schema.complianceExemption.orgId, orgId),
          eq(schema.complianceExemption.status, 'approved'),
          eq(schema.complianceExemption.expiresAt, current),
        ))
        .returning();

      if (!updated) throw new Error(CE_NOT_EXTENDABLE);
      return { exemption: updated, previousExpiresAt: current };
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
