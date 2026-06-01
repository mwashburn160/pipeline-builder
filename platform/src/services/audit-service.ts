// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import AuditEvent, { type AuditAction, type AuditEventDocument } from '../models/audit-event';
import { escapeRegex } from '../utils/regex';

export interface AuditFilter {
  /** Actor's org at action-time. */
  orgId?: string;
  /** Org operated ON. Differs from `orgId` for cross-tenant sysadmin actions
   *  (sysadmin acting on org X). Filtering on this answers "what was done
   *  to org X" regardless of which actor performed it. */
  affectedOrgId?: string;
  /**
   * Match events where EITHER `orgId` OR `affectedOrgId` equals this value.
   * Use for org admins reading their own org's audit: they should see
   * events their org acted (orgId) AND events another org acted on them
   * (affectedOrgId). When set, `orgId`/`affectedOrgId` filters above are
   * ignored to keep the predicate single-shaped.
   */
  orgIdOrAffected?: string;
  /** Specific user who performed the action. */
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

export interface AuditCreateInput {
  action: AuditAction;
  actorId: string;
  actorEmail?: string;
  orgId?: string;
  /** Org being operated on (cross-tenant sysadmin actions). Falls back to
   *  `orgId` when omitted, matching how the audit helper auto-populates it. */
  affectedOrgId?: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export interface PaginatedAuditResult {
  events: AuditEventDocument[];
  pagination: { total: number; offset: number; limit: number; hasMore: boolean };
}

/**
 * Service layer for audit events — replaces inline Mongoose queries in routes.
 */
class AuditService {
  /**
   * Find audit events with filtering and pagination.
   */
  async findEvents(
    filter: AuditFilter,
    offset: number,
    limit: number,
  ): Promise<PaginatedAuditResult> {
    const query: Record<string, unknown> = {};

    if (filter.orgIdOrAffected) {
      // Org-admin reads need union: events actor=their-org OR target=their-org.
      query.$or = [
        { orgId: filter.orgIdOrAffected },
        { affectedOrgId: filter.orgIdOrAffected },
      ];
    } else {
      if (filter.orgId) query.orgId = filter.orgId;
      if (filter.affectedOrgId) query.affectedOrgId = filter.affectedOrgId;
    }
    if (filter.actorId) query.actorId = filter.actorId;
    if (filter.action) {
      query.action = { $regex: escapeRegex(filter.action), $options: 'i' };
    }
    if (filter.targetType) query.targetType = filter.targetType;
    if (filter.targetId) query.targetId = filter.targetId;

    const [events, total] = await Promise.all([
      AuditEvent.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      AuditEvent.countDocuments(query),
    ]);

    return {
      events: events as AuditEventDocument[],
      pagination: { total, offset, limit, hasMore: offset + limit < total },
    };
  }

  /**
   * Create a new audit event. For fire-and-forget writes from request
   * handlers, prefer the `audit()` helper in `helpers/audit.ts` — it
   * also auto-populates `affectedOrgId` from the Express request.
   */
  async createEvent(input: AuditCreateInput): Promise<AuditEventDocument> {
    const event = await AuditEvent.create(input);
    return event;
  }
}

export const auditService = new AuditService();
